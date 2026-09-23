import { RecurrenceFrequency } from '@prisma/client';

/** Meses entre duas ocorrências de um lançamento fixo. */
export const FREQUENCY_STEP_MONTHS: Record<RecurrenceFrequency, number> = {
  monthly: 1,
  bimonthly: 2,
  semiannual: 6,
  annual: 12,
};
