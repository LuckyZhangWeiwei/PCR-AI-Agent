import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildYieldByPassId } from "../src/lib/infcontrol/jbYieldCalc.js";
import { wrapJbQueryResultForAgent } from "../src/lib/agent/agentJbBinFormat.js";

/** 25 slot × 3 pass × 4 行/组 = 300 行；TESTEND 越晚越靠前，limit 200 仅含 pass3+pass5。 */
function mockLot300Rows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let slot = 1; slot <= 25; slot++) {
    for (const passId of [1, 3, 5]) {
      for (let passNum = 1; passNum <= 4; passNum++) {
        const day =
          passId === 1 ? passNum : passId === 3 ? 10 + passNum : 20 + passNum;
        const cardId =
          passId === 1 ? "8003-10" : passId === 3 ? "8003-21" : "8003-05";
        rows.push({
          LOT: "NF12827.1R",
          DEVICE: "WB10N57U",
          SLOT: slot,
          CARDID: cardId,
          PASSID: passId,
          PASSNUM: passNum,
          PASSTYPE: passNum === 1 && passId === 1 ? "INTERRUPT" : "TEST",
          GROSSDIE: 4000,
          TESTEND: `2026-05-${String(day).padStart(2, "0")}T12:00:00`,
          bins: [
            { n: 1, value: 3900, isGoodBin: true },
            { n: 5, value: 1, isGoodBin: false },
          ],
        });
      }
    }
  }
  return rows;
}

function sortLikeApi(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((a, b) => {
    const tb = new Date(String(b.TESTEND)).getTime();
    const ta = new Date(String(a.TESTEND)).getTime();
    if (tb !== ta) return tb - ta;
    return Number(b.SLOT) - Number(a.SLOT);
  });
}

describe("jb agent lot-scoped full rows", () => {
  it("limit 200 on 300-row lot drops passId=1 from yieldByPassId", () => {
    const sorted = sortLikeApi(mockLot300Rows());
    const truncated = sorted.slice(0, 200);
    const byPass = buildYieldByPassId(truncated).map((p) => p.passId);
    assert.ok(!byPass.includes(1), "truncated set should miss sort1");
    assert.ok(byPass.includes(3) || byPass.includes(5));
  });

  it("full lot rows include passIds 1, 3, 5 in wrap", () => {
    const wrapped = wrapJbQueryResultForAgent(mockLot300Rows(), {
      lotScopedFullRows: true,
    });
    assert.deepEqual(wrapped.passIdsPresent, [1, 3, 5]);
    const byPass = wrapped.yieldByPassId as Array<{ passId: number }>;
    assert.equal(byPass.length, 3);
    assert.ok(String(wrapped.yieldByPassIdMarkdown).includes("pass1"));
    assert.ok(String(wrapped.yieldByPassIdMarkdown).includes("pass3"));
    assert.ok(String(wrapped.yieldByPassIdMarkdown).includes("pass5"));
    assert.ok(!String(wrapped.yieldByPassIdMarkdown).includes("常温"));
    assert.equal(wrapped.lotQueryFullRows, true);
    const summary = wrapped.slotYieldSummary as unknown[];
    assert.equal(summary.length, 75);
    assert.ok(String(wrapped.cardByPassIdMarkdown).includes("pass1"));
  });
});
