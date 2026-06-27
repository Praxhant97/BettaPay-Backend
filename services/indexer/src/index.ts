/**
 * Indexer Service — BettaPay Backend
 *
 * Listens to Soroban contract event streams and indexes payment/settlement events.
 * Polls the Stellar RPC for contract events on the SETTLEMENT_CONTRACT_ID.
 *
 * Endpoints:
 *   GET /api/events              — list indexed events (newest first, paginated)
 *   GET /api/health              — liveness probe
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import crypto from 'crypto';
import { rpc } from '@stellar/stellar-sdk';
import { PrismaClient } from '@prisma/client';
import { validateEnv, registerErrorHandler, PaginationQuery } from '@bettapay/validation';

const env = validateEnv(process.env);
const PORT = Number(process.env.PORT ?? '3003');

const fastify = Fastify({ logger: true });
const prisma = new PrismaClient();

fastify.register(cors, {
  origin: env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
});
registerErrorHandler(fastify);

fastify.addHook('onClose', async () => {
  await prisma.$disconnect();
});

let latestLedgerCursor: number | undefined = undefined;

async function pushEvent(
  topic: string,
  contractId: string,
  data: Record<string, unknown>,
  ledger: number,
) {
  const id = 'evt_' + crypto.randomUUID().replace(/-/g, '');
  await prisma.indexedEvent.create({ data: { id, contractId, topic, ledger, data } });
  fastify.log.info(`[Indexer] ${topic} — ${id} (Ledger ${ledger})`);
  return id;
}

// HTTP API
fastify.get('/api/health', async (_request, _reply) => {
  const total = await prisma.indexedEvent.count();
  return { status: 'ok', indexedEvents: total, latestLedgerCursor };
});

fastify.get('/api/events', async (request, _reply) => {
  const { limit, offset } = PaginationQuery.parse(request.query ?? {});
  const [events, total] = await Promise.all([
    prisma.indexedEvent.findMany({
      take: limit,
      skip: offset,
      orderBy: { indexedAt: 'desc' },
    }),
    prisma.indexedEvent.count(),
  ]);
  return { events, total, limit, offset, hasMore: offset + limit < total, latestLedgerCursor };
});

const server = new rpc.Server(env.STELLAR_RPC_URL, { allowHttp: true });

async function pollEvents() {
  try {
    if (!latestLedgerCursor) {
      const latest = await server.getLatestLedger();
      latestLedgerCursor = latest.sequence;
    }

    const request = {
      startLedger: latestLedgerCursor,
      filters: [
        {
          type: 'contract' as const,
          contractIds: [env.SETTLEMENT_CONTRACT_ID],
          topics: [],
        }
      ],
      limit: 100,
    };

    const response = await server.getEvents(request);

    if (response.events && response.events.length > 0) {
      for (const evt of response.events) {
        await pushEvent(
          evt.topic.join(','),
          evt.contractId ? evt.contractId.toString() : 'unknown',
          { rawValue: evt.value.toXDR('base64') },
          evt.ledger,
        );
        latestLedgerCursor = Math.max(latestLedgerCursor, evt.ledger + 1);
      }
    } else {
      // No new events — advance cursor to latest ledger
      const latest = await server.getLatestLedger();
      latestLedgerCursor = Math.max(latestLedgerCursor, latest.sequence);
    }
  } catch (err) {
    fastify.log.error(`[Indexer] Polling error: ${err}`);
  } finally {
    setTimeout(pollEvents, 5000);
  }
}

const start = async () => {
  try {
    // Recover cursor from last persisted event so we don't reprocess on restart
    const latestEvent = await prisma.indexedEvent.findFirst({
      orderBy: { ledger: 'desc' },
      select: { ledger: true },
    });
    if (latestEvent) {
      latestLedgerCursor = latestEvent.ledger + 1;
    }

    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info('[Indexer] Starting Stellar RPC polling loop...');
    pollEvents();
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
