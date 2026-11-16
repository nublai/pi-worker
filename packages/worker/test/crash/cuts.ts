/**
 * Cut scenarios by durable label. Every label in `src/journal/labels.ts` must appear here; the label-coverage test
 * (`journal-labels.test.ts`) fails otherwise and proves each scenario really reaches its labels. The cuts themselves
 * run in the crash test file named by `file`, with that file's recovery oracle.
 */
export interface CutScenario {
  /** A mode of `fixtures/scenario.ts`. */
  readonly scenario: string;
  /** The crash test file that cuts this scenario at every occurrence of its labels. */
  readonly file: string;
  readonly labels: readonly string[];
}

export const CUT_SCENARIOS: readonly CutScenario[] = [
  { scenario: 'journal', file: 'journal.test.ts', labels: ['journal.open_file', 'journal.open_directory', 'supervisor.start'] },
];
