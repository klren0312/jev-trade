import { test } from "node:test";
import assert from "node:assert/strict";

import { toSymbol, parseAssets, decimalsFromTick, diffAssets, DEFAULT_QUOTE } from "../src/assets.mjs";

test("symbols are built from whatever the operator types", () => {
  assert.equal(toSymbol("apt"), "APTUSDT");
  assert.equal(toSymbol("APT/USDT"), "APTUSDT");
  assert.equal(toSymbol("apt-usdt"), "APTUSDT");
  assert.equal(toSymbol("APTUSDT"), "APTUSDT"); // already a pair, not APTUSDTUSDT
  assert.equal(toSymbol("", DEFAULT_QUOTE), null);
  assert.equal(toSymbol("APT USDT", DEFAULT_QUOTE), "APTUSDT");
  assert.equal(toSymbol("!!!", DEFAULT_QUOTE), null);
  assert.equal(toSymbol("SUPERLONGTICKER1234", DEFAULT_QUOTE), null); // >12 chars
});

test("a list is parsed, deduped and stripped to base assets", () => {
  assert.deepEqual(parseAssets("btc, eth"), ["BTC", "ETH"]);
  assert.deepEqual(parseAssets("BTC ETH;APT、SOL"), ["BTC", "ETH", "APT", "SOL"]);
  assert.deepEqual(parseAssets(["pepe/usdt", "PEPE"]), ["PEPE"]);
  assert.deepEqual(parseAssets(""), []);
  assert.deepEqual(parseAssets(" ,, "), []);
  assert.deepEqual(parseAssets(undefined), []);
});

test("tickSize decides display decimals", () => {
  assert.equal(decimalsFromTick("0.00100000"), 3);
  assert.equal(decimalsFromTick("0.00000001"), 8);
  assert.equal(decimalsFromTick("1.00000000"), 0);
  assert.equal(decimalsFromTick("0.10000000"), 1);
  assert.equal(decimalsFromTick(undefined), 2);
  assert.equal(decimalsFromTick("nonsense"), 2);
});

test("diff adds and removes without touching the rest", () => {
  assert.deepEqual(diffAssets(["APT"], ["APT", "BTC"]), { add: ["BTC"], remove: [] });
  assert.deepEqual(diffAssets(["APT", "ETH"], ["ETH"]), { add: [], remove: ["APT"] });
  assert.deepEqual(diffAssets([], []), { add: [], remove: [] });
  assert.deepEqual(diffAssets(["APT"], ["BTC"]), { add: ["BTC"], remove: ["APT"] });
});
