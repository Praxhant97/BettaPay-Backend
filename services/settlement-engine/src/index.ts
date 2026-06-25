/**
 * Settlement Engine — BettaPay Backend
 *
 * Handles settlement processing with fee deduction and audit trail.
 *
 * Endpoints:
 *   GET  /api/health              — liveness and Redis connectivity probe
 *   GET  /api/settlements         — list all settlements
 *   POST /api/settlements         — create and process a settlement
 *
 * Precision strategy
 * ──────────────────
 * All monetary arithmetic uses BigNumber.js (ROUND_DOWN, no floating-point).
 * Fee basis points are applied as:
 *   feeAmount  = floor(grossAmount × feeBps / 10 000, asset decimals)
 *   netAmount  = grossAmount − feeAmount
 *
 * All three amounts (grossAmount, feeAmount, netAmount) are stored as
 * decimal strings so the database never loses sub-cent precision for
 * assets like USDC (6 dp) or XLM (7 dp).
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import crypto from 'crypto';
import Redis from 'ioredis';
import { PrismaClient, Settlement } from '@prisma/client';
import BigNumber from 'bignumber.js';
import { computeSettlementAmounts } from './settlement-amounts.js';
import {
  validateEnv,
  CreateSettlementBody,
} from "@bettapay/validation";
import { Queue, Worker } from 'bullmq';

interface CreateSettlementRouteBody {
  merchantId?: unknown;
  amount?: unknown;
  asset?: unknown;
}

const env = validateEnv(process.env);
const PORT = Number(process.env.PORT ?? '3001');
const startTime = Date.now();

const prisma = new PrismaClient();

type SettlementJobData = {
  id: string;
  merchantId: string;
  grossAmount: string;
  asset: string;
};

const fastify = Fastify({
  logger: true,
  // Explicitly set body limit to 1MB (Fastify's default)
  bodyLimit: 1_048_576,
  genReqId: function (req) {
    return (req.headers['x-request-id'] as string) || crypto.randomUUID();
  }
});

const redis = new Redis(env.REDIS_URL);

fastify.addHook('onClose', async () => {
  await redis.quit();
});

fastify.register(cors, { 
  origin: env.ALLOWED_ORIGINS.split(',').map((o: string) => o.trim()) 
});

fastify.register(helmet, { contentSecurityPolicy: false });

const redisConnection = new URL(env.REDIS_URL);
const connectionParams = {
  host: redisConnection.hostname,
  port: parseInt(redisConnection.port || '6379', 10),
};

async function sendWebhookWithRetries(url: string, payload: any, maxRetries = 3, initialDelay = 1000): Promise<void> {
  let attempt = 0;
  while (attempt <= maxRetries) {
    attempt++;
    fastify.log.info({ url, attempt, payload }, 'Attempting to send webhook notification');
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5-second timeout

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseBody = await response.text().catch(() => '');
      
      fastify.log.info({
        url,
        attempt,
        status: response.status,
        response: responseBody,
      }, 'Webhook delivery attempt completed');

      if (response.ok) {
        return; // Success!
      }

      throw new Error(`Webhook responded with status ${response.status}`);
    } catch (error) {
      fastify.log.warn({
        url,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      }, 'Webhook delivery attempt failed');

      if (attempt > maxRetries) {
        throw new Error(`Webhook delivery failed after ${maxRetries} retries: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Exponential backoff
      const delay = initialDelay * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

const settlementQueue = new Queue('settlements', { connection: connectionParams });

new Worker('settlements', async job => {
  const settlementId = job.data.id;
  
  fastify.log.info({
    jobId: job.id,
    merchantId: job.data.merchantId,
    amount: job.data.grossAmount,
    asset: job.data.asset,
    jobName: job.name
  }, 'Processing settlement job');

  const settlement = await prisma.settlement.findUnique({
    where: { id: settlementId }
  });

  if (!settlement) {
    throw new Error(`Settlement ${settlementId} not found`);
  }

  // If already in a terminal state, we just make sure the webhook is delivered
  if (settlement.status === 'completed' || settlement.status === 'failed') {
    fastify.log.info({ settlementId, status: settlement.status }, 'Settlement already processed, sending webhook');
    if (settlement.webhookUrl) {
      await sendWebhookWithRetries(settlement.webhookUrl, {
        event: `settlement.${settlement.status}`,
        data: settlement,
      });
    }
    return;
  }

  try {
    // In a real app, this interacts with Soroban
    // Simulate settlement processing success
    const updatedSettlement = await prisma.settlement.update({
      where: { id: settlementId },
      data: {
        status: 'completed',
        completedAt: new Date(),
      },
    });

    fastify.log.info({ settlementId }, 'Settlement completed in database');

    if (updatedSettlement.webhookUrl) {
      await sendWebhookWithRetries(updatedSettlement.webhookUrl, {
        event: 'settlement.completed',
        data: updatedSettlement,
      });
    }
  } catch (error) {
    fastify.log.error({ error, settlementId }, 'Settlement processing failed');

    const updatedSettlement = await prisma.settlement.update({
      where: { id: settlementId },
      data: {
        status: 'failed',
        completedAt: new Date(),
      },
    }).catch(() => null);

    if (updatedSettlement && updatedSettlement.webhookUrl) {
      await sendWebhookWithRetries(updatedSettlement.webhookUrl, {
        event: 'settlement.failed',
        data: updatedSettlement,
      }).catch(err => {
        fastify.log.error({ err, settlementId }, 'Failed to send failure webhook');
      });
    }

    throw error;
  }
}, {
  connection: connectionParams,
  concurrency: 5,
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
});

// In-memory store for development (Gateway uses DB, this worker processes memory queue)
const settlements: Settlement[] = [];

fastify.get('/api/health', async (_request, reply) => {
  let redisConnected = false;

  try {
    await settlementQueue.getJobCounts();
    redisConnected = true;
  } catch (error) {
    fastify.log.warn({ error }, 'Settlement Redis health check failed');
  }

  return reply.code(200).send({
    status: redisConnected ? 'ok' : 'degraded',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    redis: {
      connected: redisConnected,
    },
  });
});

fastify.get('/api/settlements', async (_request, reply) => {
  const records = await prisma.settlement.findMany({
    orderBy: { initiatedAt: 'desc' },
  });
  return { settlements: records, total: records.length };
});

fastify.post<{ Body: CreateSettlementRouteBody }>('/api/settlements', async (request, reply) => {
  try {
    const d = CreateSettlementBody.parse(request.body);

    // Validate that the amount is positive without floating-point conversion
    const grossBN = new BigNumber(d.amount ?? '0');
    if (!grossBN.isFinite() || grossBN.isLessThanOrEqualTo(0)) {
      return reply.code(400).send({ error: 'amount must be > 0' });
    }

    const merchant = await prisma.merchant.findUnique({ where: { id: d.merchantId } });
    const settings = merchant?.settings as { feeBps?: number; webhookUrl?: string } | null | undefined;
    const feeBps = typeof settings?.feeBps === 'number' && Number.isFinite(settings.feeBps) ? settings.feeBps : env.FEES_DEFAULT_BPS;
    const webhookUrl = settings?.webhookUrl || null;

    const { grossAmount, feeAmount, netAmount } = computeSettlementAmounts(d.amount, feeBps);

    const rawIdempotencyKey = request.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(rawIdempotencyKey) ? rawIdempotencyKey[0] : rawIdempotencyKey;

    if (idempotencyKey) {
      const existingSettlementId = await redis.get(`idempotency:${idempotencyKey}`);
      if (existingSettlementId) {
        const existingSettlement = await prisma.settlement.findUnique({
          where: { id: existingSettlementId },
        });
        if (existingSettlement) {
          return reply.code(200).send(existingSettlement);
        }
      }
    }

    const settlement = await prisma.settlement.create({
      data: {
        id: 'set_' + crypto.randomUUID().replace(/-/g, ''),
        merchantId: d.merchantId,
        totalAmount: grossAmount,
        grossAmount,
        feeAmount,
        netAmount,
        feeBps,
        asset: d.asset,
        status: 'pending',
        webhookUrl,
      },
    });

    const jobData: SettlementJobData = {
      id: settlement.id,
      merchantId: settlement.merchantId,
      grossAmount: settlement.grossAmount,
      asset: settlement.asset,
    };

    await settlementQueue.add('process-settlement', jobData, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    });

    if (idempotencyKey) {
      // 24-hour TTL (24 * 60 * 60 = 86400 seconds)
      await redis.set(`idempotency:${idempotencyKey}`, settlement.id, 'EX', 86400);
    }

    return reply.code(201).send(settlement);
  } catch (error) {
    return reply.code(400).send({ error: 'Invalid request payload' });
  }
});

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
