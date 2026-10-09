import { computed, ref, watch, type Ref } from "vue";
import { activeConditionCount, EMPTY_FILTER, normalizeFilter, type RowFilter } from "@/core/filter/rowFilter";

/**
 * A row filter saved in localStorage and kept across encounters (docs/DESIGN.md 7.2). The monitor
 * and the review window each have their own. Storage can throw in embedded browsers; the filter
 * then lives in memory.
 */
export interface FilterState {
  filter: Ref<RowFilter>;
  count: Readonly<Ref<number>>;
  update(patch: Partial<RowFilter>): void;
  clear(): void;
}

function createFilterState(storageKey: string): FilterState {
  let initial: RowFilter;
  try {
    initial = normalizeFilter(JSON.parse(localStorage.getItem(storageKey) ?? "null"));
  } catch {
    initial = normalizeFilter(undefined);
  }
  const filter = ref<RowFilter>(initial);
  let saveTimer: number | undefined;
  watch(
    filter,
    (value) => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        try {
          localStorage.setItem(storageKey, JSON.stringify(value));
        } catch {
          // unavailable: keep it in memory only
        }
      }, 200);
    },
    { deep: true },
  );
  return {
    filter,
    count: computed(() => activeConditionCount(filter.value)),
    update(patch) {
      filter.value = { ...filter.value, ...patch };
    },
    clear() {
      filter.value = normalizeFilter(EMPTY_FILTER);
    },
  };
}

let monitor: FilterState | undefined;
let review: FilterState | undefined;

export function useMonitorFilter(): FilterState {
  return (monitor ??= createFilterState("mitigation-monitoring:monitor-filter"));
}

export function useReviewFilter(): FilterState {
  return (review ??= createFilterState("mitigation-monitoring:review-filter"));
}
