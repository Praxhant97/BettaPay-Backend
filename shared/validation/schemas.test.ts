import test from 'node:test';
import assert from 'node:assert';
import {
  DateRangeQuery,
  PaginationQuery,
  AmountString,
  PositiveAmountString,
  CreatePaymentBody,
  CreateSettlementBody,
} from './schemas.js';

test('PaginationQuery validation', async (t) => {
  await t.test('Default limit is 50', () => {
    const result = PaginationQuery.parse({});
    assert.strictEqual(result.limit, 50);
  });

  await t.test('Default offset is 0', () => {
    const result = PaginationQuery.parse({});
    assert.strictEqual(result.offset, 0);
  });

  await t.test('Custom limit works', () => {
    const result = PaginationQuery.parse({ limit: 100 });
    assert.strictEqual(result.limit, 100);
  });

  await t.test('Custom offset works', () => {
    const result = PaginationQuery.parse({ offset: 10 });
    assert.strictEqual(result.offset, 10);
  });

  await t.test('Limit above 200 fails', () => {
    assert.throws(() => PaginationQuery.parse({ limit: 201 }), /Number must be less than or equal to 200/);
  });

  await t.test('Negative offset fails', () => {
    assert.throws(() => PaginationQuery.parse({ offset: -1 }), /Number must be greater than or equal to 0/);
  });

  await t.test('Additional query parameters are accepted with passthrough', () => {
    const PassthroughQuery = PaginationQuery.passthrough();
    const result = PassthroughQuery.parse({ limit: 10, offset: 5, sort: 'desc', filter: 'active' }) as any;
    assert.strictEqual(result.limit, 10);
    assert.strictEqual(result.offset, 5);
    assert.strictEqual(result.sort, 'desc');
    assert.strictEqual(result.filter, 'active');
  });
  
  await t.test('Coerces string values to numbers', () => {
    const result = PaginationQuery.parse({ limit: '25', offset: '5' });
    assert.strictEqual(result.limit, 25);
    assert.strictEqual(result.offset, 5);
  });
});

test('DateRangeQuery validation', async (t) => {
  await t.test('Valid ISO from date passes', () => {
    const from = new Date('2023-01-01').toISOString();
    const result = DateRangeQuery.parse({ from });
    assert.strictEqual(result.from, from);
    assert.ok(result.to); // Default applies
  });

  await t.test('Valid ISO to date passes', () => {
    const to = new Date('2023-12-31').toISOString();
    const result = DateRangeQuery.parse({ to });
    assert.strictEqual(result.to, to);
    assert.strictEqual(result.from, undefined);
  });

  await t.test('Invalid date strings fail', () => {
    assert.throws(() => DateRangeQuery.parse({ from: 'not-a-date' }), /Invalid ISO date string/);
    assert.throws(() => DateRangeQuery.parse({ to: 'also-not-a-date' }), /Invalid ISO date string/);
  });

  await t.test('from earlier than to passes', () => {
    const from = new Date('2023-01-01').toISOString();
    const to = new Date('2023-12-31').toISOString();
    const result = DateRangeQuery.parse({ from, to });
    assert.strictEqual(result.from, from);
    assert.strictEqual(result.to, to);
  });

  await t.test('from after to fails', () => {
    const from = new Date('2023-12-31').toISOString();
    const to = new Date('2023-01-01').toISOString();
    assert.throws(() => DateRangeQuery.parse({ from, to }), /from must be before to/);
  });

  await t.test('Missing to defaults to current time', () => {
    const before = new Date();
    const result = DateRangeQuery.parse({});
    const after = new Date();
    const toDate = new Date(result.to!);
    
    assert.ok(toDate >= before && toDate <= after);
    assert.strictEqual(result.from, undefined);
  });

  await t.test('Missing fields are handled correctly', () => {
    const result = DateRangeQuery.parse({});
    assert.strictEqual(result.from, undefined);
    assert.ok(result.to); // Default applies
  });
});

test('AmountString validation', async (t) => {
  await t.test('Valid numeric strings pass', () => {
    assert.strictEqual(AmountString.parse('123'), '123');
    assert.strictEqual(AmountString.parse('0'), '0');
    assert.strictEqual(AmountString.parse('12.34'), '12.34');
    assert.strictEqual(AmountString.parse('0.0'), '0.0');
  });

  await t.test('Invalid numeric strings fail', () => {
    assert.throws(() => AmountString.parse('abc'), /amount must be a numeric string/);
    assert.throws(() => AmountString.parse('12.34.56'), /amount must be a numeric string/);
    assert.throws(() => AmountString.parse('-12.3'), /amount must be a numeric string/);
  });
});

test('PositiveAmountString validation', async (t) => {
  await t.test('Positive numeric strings pass', () => {
    assert.strictEqual(PositiveAmountString.parse('123'), '123');
    assert.strictEqual(PositiveAmountString.parse('12.34'), '12.34');
    assert.strictEqual(PositiveAmountString.parse('0.01'), '0.01');
  });

  await t.test('Zero fails', () => {
    assert.throws(() => PositiveAmountString.parse('0'), /Amount must be greater than zero/);
    assert.throws(() => PositiveAmountString.parse('0.0'), /Amount must be greater than zero/);
  });

  await t.test('Negative values fail', () => {
    assert.throws(() => PositiveAmountString.parse('-1'), /amount must be a numeric string/);
    assert.throws(() => PositiveAmountString.parse('-0.01'), /amount must be a numeric string/);
  });
});

test('CreatePaymentBody validation', async (t) => {
  await t.test('Valid payment body passes', () => {
    const valid = {
      merchantId: 'mer_123',
      amount: '100.50',
      asset: 'USDC',
    };
    const result = CreatePaymentBody.parse(valid);
    assert.deepStrictEqual(result, valid);
  });

  await t.test('Invalid amount in payment body fails', () => {
    assert.throws(() => CreatePaymentBody.parse({
      merchantId: 'mer_123',
      amount: 'abc',
      asset: 'USDC',
    }), /amount must be a numeric string/);
  });
});

test('CreateSettlementBody validation', async (t) => {
  await t.test('Valid single settlement passes', () => {
    const valid = {
      merchantId: 'mer_123',
      amount: '500',
      asset: 'EURT',
    };
    const result = CreateSettlementBody.parse(valid);
    assert.deepStrictEqual(result, valid);
  });

  await t.test('Valid batch settlement passes', () => {
    const valid = {
      merchantId: 'mer_123',
      items: [
        { amount: '100.50', asset: 'USDC' },
        { amount: '200', asset: 'EURT' },
      ],
    };
    const result = CreateSettlementBody.parse(valid);
    assert.deepStrictEqual(result, valid);
  });

  await t.test('Invalid amount in single settlement fails', () => {
    assert.throws(() => CreateSettlementBody.parse({
      merchantId: 'mer_123',
      amount: '-50',
      asset: 'EURT',
    }), /amount must be a numeric string/);
  });

  await t.test('Invalid amount in batch settlement items fails', () => {
    assert.throws(() => CreateSettlementBody.parse({
      merchantId: 'mer_123',
      items: [
        { amount: '100.50', asset: 'USDC' },
        { amount: 'abc', asset: 'EURT' },
      ],
    }), /amount must be a numeric string/);
  });
});
