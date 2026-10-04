// FAILS ON THE BASELINE, AS cx-shared's DatePicker/AdvancedDatePicker suites do (AMSD-2974, 2026-10-04):
// a pre-existing failure no story causes. Every gate must subtract it, never charge it to the fix.
import { describe, it, expect } from 'vitest';

describe('datepicker', () => {
  it('reads the year of a date (broken before any story touched this codeline)', () => {
    expect(new Date('2026-01-15T15:00:00Z').getUTCFullYear()).toBe(2025);
  });
});
