/**
 * Which job an action belongs to, for evaluating its tooltip's job conditions (`<If(Equal(PlayerParameter(68),40))>`).
 * Its ClassJob, or, for an action another one turns into (均衡诊断, 均衡预后, 技巧舞步结束…: ClassJob 0 in the Action
 * sheet, the global sheet too), the one class or job its ClassJobCategory lists (181: 贤者 only). Column numbers: the
 * CN sheet's column names are stale; ClassJobCategory is raw 50 (agrees with the global sheet's on every action).
 */
import { cnRows } from "./sources";

/** Action sheet raw columns. */
const ACTION_CLASS_JOB = 10;
const ACTION_CLASS_JOB_CATEGORY = 50;

/** ClassJobCategory sheet: raw column j + 1 says whether ClassJob j is in it (raw 0 is the name). */
export function jobCategories(classJobCategoryCsv: string): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const [id, cells] of cnRows(classJobCategoryCsv)) {
    const jobs: number[] = [];
    // cells[0] is the row id, so raw column j + 1 is cells[j + 2].
    for (let j = 0; j + 2 < cells.length; j++) if (cells[j + 2] === "True") jobs.push(j);
    out.set(id, jobs);
  }
  return out;
}

/** The action's job: its ClassJob when it has one, else the one its ClassJobCategory lists; 0 when neither says. */
export function actionJob(cells: readonly string[], categories: ReadonlyMap<number, readonly number[]>): number {
  const job = Number(cells[ACTION_CLASS_JOB + 1]);
  if (job > 0) return job;
  const jobs = categories.get(Number(cells[ACTION_CLASS_JOB_CATEGORY + 1])) ?? [];
  return jobs.length === 1 ? jobs[0]! : 0;
}
