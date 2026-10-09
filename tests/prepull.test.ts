import { describe, expect, it } from "vitest";
import { PrepullState } from "@/core/archive/prepull";

const at = (s: number) => new Date(Date.UTC(2026, 8, 20, 0, 0, s)).toISOString();
const line = (type: string, s: number, ...fields: string[]) => [type, at(s), ...fields];

describe("PrepullState", () => {
  it("keeps state from before the window and the last 30 s of lines", () => {
    const p = new PrepullState();
    p.push(line("01", 0, "514", "Zone"));
    p.push(line("02", 0, "10000001", "P1"));
    p.push(line("03", 0, "10000001", "P1", "23", "64", "0000"));
    p.push(line("03", 0, "40000009", "Gone", "0", "64", "0000"));
    p.push(line("04", 1, "40000009", "Gone"));
    p.push(line("11", 1, "1", "10000001"));
    p.push(line("26", 2, "30", "进食", "3600.00", "10000001", "P1", "10000001", "P1", "00"));
    p.push(line("26", 3, "4C", "Short", "5.00", "10000001", "P1", "10000001", "P1", "00"));
    p.push(line("26", 4, "4D", "Removed", "60.00", "10000001", "P1", "10000001", "P1", "00"));
    p.push(line("30", 5, "4D", "Removed", "0.00", "10000001", "P1", "10000001", "P1", "00"));
    p.push(line("21", 10, "old"));
    p.push(line("21", 50, "recent"));
    p.push(line("260", 60, "1", "0"));

    const snap = p.snapshot(Date.parse(at(60)));
    expect(snap.map((l) => `${l[0]}:${l[2]}`)).toEqual([
      "01:514",
      "02:10000001",
      "03:10000001",
      "11:1",
      "26:30", // food: applied before the window and still running
      "26:4C", // ran out, but no 30 line came: still on (statuses last until their 30 line)
      "21:recent",
      "260:1",
    ]);
  });

  it("keeps the line that put on a status still running", () => {
    const p = new PrepullState();
    p.push(line("01", 0, "514", "Zone"));
    p.push(line("21", 3, "10000001", "P1", "1D6F", "雪仇", "40000001", "Boss", "F60E", "4A90000"));
    p.push(line("26", 3, "4A9", "雪仇", "60.00", "10000001", "P1", "40000001", "Boss", "00"));
    p.push(line("260", 40, "1", "0"));
    const snap = p.snapshot(Date.parse(at(40)));
    expect(snap.map((l) => l[0])).toEqual(["01", "21", "26", "260"]);
  });

  it("a zone change resets everything", () => {
    const p = new PrepullState();
    p.push(line("03", 0, "10000001", "P1"));
    p.push(line("01", 1, "155", "Other"));
    expect(p.snapshot(Date.parse(at(1))).map((l) => l[0])).toEqual(["01"]);
  });

  it("drops a removed combatant's statuses, so hours in the open world stay bounded", () => {
    const p = new PrepullState();
    p.push(line("03", 0, "40000001", "Mob", "0", "64", "0000"));
    p.push(line("26", 0, "4A9", "雪仇", "9999.00", "10000001", "P1", "40000001", "Mob", "00"));
    p.push(line("04", 1, "40000001", "Mob"));
    p.push(line("21", 100, "later"));
    expect(p.snapshot(Date.parse(at(100))).map((l) => l[0])).toEqual(["21"]);
  });

  it("does not repeat a window line in the header when timestamps run out of order", () => {
    const p = new PrepullState();
    p.push(line("21", 10, "first"));
    p.push(line("03", 9, "10000001", "P1")); // logged after a later-stamped line
    expect(p.snapshot(Date.parse(at(10))).map((l) => `${l[0]}:${l[2]}`)).toEqual(["21:first", "03:10000001"]);
  });
});
