import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annualPrice } from '../../api/services/annualPricing.js';

test('new annual prices use runtime CNY settings and cannot retain stale foreign-currency quotes', () => {
  const original=process.env.PRO_PRICE_CNY_YEARLY;
  try {
    process.env.PRO_PRICE_CNY_YEARLY='1599';
    const rate=7.2,quote=annualPrice('pro',rate,7.8);
    assert.equal(quote.cny,1599);
    assert.ok(quote.usd*rate>=1599 && quote.usd*rate<1599+.01*rate);
    assert.ok(quote.hkd/7.8*rate>=1599 && quote.hkd/7.8*rate<1599+.01/7.8*rate);
    process.env.PRO_PRICE_CNY_YEARLY='1700';
    assert.equal(annualPrice('pro',rate,7.8).cny,1700);
    for(const bad of ['-1','0','garbage','12.345']){
      process.env.PRO_PRICE_CNY_YEARLY=bad;
      assert.throws(()=>annualPrice('pro',rate,7.8),/INVALID_ANNUAL_PRICE_CONFIGURATION/);
    }
  } finally { if(original===undefined)delete process.env.PRO_PRICE_CNY_YEARLY;else process.env.PRO_PRICE_CNY_YEARLY=original; }
  assert.deepEqual(annualPrice('flagship',7.2,7.8),{cny:0,usd:0,hkd:0});
});
