import env from '@/configs/env';

export type CapCutRegionProfileName = 'primary' | 'fallback';

export interface CapCutRegionProfile {
  name: CapCutRegionProfileName;
  locale: string;
  pageLocale: string;
  region: string;
  storeCountryCode: string;
}

export const getCapCutRegionProfile = (
  name: CapCutRegionProfileName
): CapCutRegionProfile =>
  name === 'fallback'
    ? {
        name,
        locale: env.CAPCUT_FALLBACK_LOCALE,
        pageLocale: env.CAPCUT_FALLBACK_PAGE_LOCALE,
        region: env.CAPCUT_FALLBACK_REGION,
        storeCountryCode: env.CAPCUT_FALLBACK_STORE_COUNTRY_CODE,
      }
    : {
        name,
        locale: env.CAPCUT_LOCALE,
        pageLocale: env.CAPCUT_PAGE_LOCALE,
        region: env.CAPCUT_REGION,
        storeCountryCode: env.CAPCUT_STORE_COUNTRY_CODE,
      };

export const isCapCutRegionFallbackEnabled = () =>
  env.CAPCUT_REGION_FALLBACK_ENABLED &&
  Boolean(
    env.CAPCUT_FALLBACK_LOCALE &&
      env.CAPCUT_FALLBACK_PAGE_LOCALE &&
      env.CAPCUT_FALLBACK_REGION &&
      env.CAPCUT_FALLBACK_STORE_COUNTRY_CODE
  );

export const shouldTryCapCutRegionFallback = (error: unknown) =>
  /workspace list failed|workspace list was empty|system busy|check login error|account info failed|region|country|forbidden|unauthorized/i.test(
    getErrorText(error)
  );

const getErrorText = (error: unknown) =>
  error instanceof Error
    ? `${error.name} ${error.message}`
    : String(error ?? '');
