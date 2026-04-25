import { z } from 'zod';

const singleBodyValue = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => {
    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }, schema);

const numericBody = (defaultValue: number) =>
  singleBodyValue(z.coerce.number().int()).default(defaultValue);

const legacyTypeBody = singleBodyValue(
  z.union([z.coerce.number().int(), z.string().trim().min(1)])
).default(0);

export const SynthesizeDocxBodySchema = z.object({
  type: legacyTypeBody,
  voice: singleBodyValue(z.string().trim().min(1)).optional(),
  pitch: numericBody(10),
  speed: numericBody(10),
  volume: numericBody(10),
  filename: singleBodyValue(z.string().trim().min(1)).optional(),
});

export type SynthesizeDocxBody = z.infer<typeof SynthesizeDocxBodySchema>;
