import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createEditApiSignature } from '@/api/capcut-edit/apiClient';
import { getUserWorkspaces } from '@/api/capcut-edit/api/getUserWorkspaces';
import { CapCutLoginApiClient } from '@/api/capcut-login/apiClient';
import { getAccountInfo } from '@/api/capcut-web/api/getAccountInfo';
import { getLoginPage } from '@/api/capcut-web/api/getLoginPage';
import env from '@/configs/env';
import { CookieJar } from '@/lib/capcut/cookieJar';
import { capCutConstants } from '@/lib/capcut/constants';
import {
  getCapCutRegionProfile,
  isCapCutRegionFallbackEnabled,
  shouldTryCapCutRegionFallback,
  type CapCutRegionProfileName,
} from '@/lib/capcut/regionProfile';
import {
  CapCutApiError,
  unwrapJsonResponse,
} from '@/lib/capcut/responseUtils';
import capCutBundleService from '@/services/CapCutBundleService';
import logger from '@/services/logger';
import type { AccountInfo, WorkspaceListResponse } from '@/types/capcutApi';
import type { CapCutSessionState } from '@/types/capcut';
import type { CapCutEditorBundleConfig } from '@/types/capcutBundle';
import type { PersistedSessionState } from '@/types/capcutSession';
import {
  createDeviceId,
  createTrackingId,
  createVerifyFp,
} from '@/utils/capcutUtils';
import { getResponseBodySnippet } from '@/utils/httpUtils';

const {
  appId,
  loginSdkVersion,
  platformId,
  signVersion,
  webAppVersion,
} = capCutConstants;

const authCookieNames = new Set([
  'sessionid',
  'sessionid_ss',
  'sid_tt',
  'uid_tt',
  'sid_guard',
  'odin_tt',
]);

export interface CapCutQrLoginTicket {
  token: string;
  qrcodeBase64: string;
  qrcodeIndexUrl?: string;
  expireTime?: number;
  next: string;
  loginHost: string;
  createdAt: number;
}

export interface CapCutQrLoginPollResult {
  status: string;
  rawStatus?: string;
  authenticated: boolean;
  session?: CapCutSessionState;
  warning?: string;
  retryAfterMs?: number;
  expiresAt?: number;
}

interface QrCodeResponseData {
  app_name?: string;
  expire_time?: number;
  qrcode?: string;
  qrcode_index_url?: string;
  token?: string;
  web_name?: string;
}

interface QrConnectResponseData {
  status?: string;
  redirect_url?: string;
  user_id?: string | number;
  uid?: string | number;
  screen_name?: string;
}

class CapCutQrLoginService {
  private readonly cookieJar = new CookieJar();

  private readonly sessionStorePath = path.resolve(
    process.cwd(),
    env.CAPCUT_SESSION_STORE_PATH
  );

  private deviceId = env.CAPCUT_DEVICE_ID ?? createDeviceId();

  private tdid = env.CAPCUT_TDID ?? createTrackingId();

  private verifyFp = env.CAPCUT_VERIFY_FP ?? createVerifyFp();

  private restored = false;

  private runtimeEditorBundleConfig: CapCutEditorBundleConfig = {
    sourceUrls: [],
  };

  private activeRegionProfile: CapCutRegionProfileName = 'primary';

  async createTicket(next = `${env.CAPCUT_WEB_URL}/my-edit`) {
    await this.restorePersistedSession();
    this.seedPassportCookies();

    try {
      return await this.createTicketWithActiveProfile(next);
    } catch (error) {
      if (this.activateFallbackRegion(error, 'CapCut QR ticket')) {
        this.seedPassportCookies();
        return this.createTicketWithActiveProfile(next);
      }

      throw error;
    }
  }

  private get regionProfile() {
    return getCapCutRegionProfile(this.activeRegionProfile);
  }

  private activateFallbackRegion(error: unknown, context: string) {
    if (
      this.activeRegionProfile === 'fallback' ||
      !isCapCutRegionFallbackEnabled() ||
      !shouldTryCapCutRegionFallback(error)
    ) {
      return false;
    }

    this.activeRegionProfile = 'fallback';

    logger.warn(
      'CapCut QR login primary region profile failed. Switching to fallback region profile',
      {
        context,
        error,
        fallbackRegion: this.regionProfile.region,
        fallbackLocale: this.regionProfile.locale,
      }
    );

    return true;
  }

  private async createTicketWithActiveProfile(next: string) {
    await this.primeCookies();

    const data = await unwrapJsonResponse<QrCodeResponseData>(
      await this.requestLoginApi('/passport/web/get_qrcode/', {
        next,
      }),
      'CapCut QR code'
    );

    if (!data.token || !data.qrcode) {
      throw new Error('CapCut QR code response did not include token/qrcode');
    }

    return {
      token: data.token,
      qrcodeBase64: data.qrcode,
      qrcodeIndexUrl: data.qrcode_index_url,
      expireTime: data.expire_time,
      next,
      loginHost: env.CAPCUT_LOGIN_HOST,
      createdAt: Date.now(),
    } satisfies CapCutQrLoginTicket;
  }

  async poll(ticket: CapCutQrLoginTicket): Promise<CapCutQrLoginPollResult> {
    await this.restorePersistedSession();

    if (this.isExpired(ticket)) {
      return {
        status: 'expired',
        rawStatus: 'expired',
        authenticated: false,
        expiresAt: ticket.expireTime ? ticket.expireTime * 1000 : undefined,
      };
    }

    const response = await this.requestLoginApi(
      '/passport/web/check_qrconnect/',
      {
        next: ticket.next,
        token: ticket.token,
      }
    );
    const setCookieNames = getSetCookieNames(response);
    const data = await unwrapJsonResponse<QrConnectResponseData>(
      response,
      'CapCut QR login status'
    );
    const rawStatus = normalizeStatus(data.status);
    const receivedAuthCookie = setCookieNames.some((name) =>
      authCookieNames.has(name.toLowerCase())
    );
    const completed =
      receivedAuthCookie ||
      (isCompletedQrStatus(rawStatus) && this.hasAuthenticatedCookies());

    if (!completed) {
      return {
        status: isFailedQrStatus(rawStatus) ? 'expired' : 'pending',
        rawStatus,
        authenticated: false,
        retryAfterMs: 2500,
        expiresAt: ticket.expireTime ? ticket.expireTime * 1000 : undefined,
      };
    }

    return this.persistAuthenticatedSession(ticket);
  }

  private async persistAuthenticatedSession(
    ticket: CapCutQrLoginTicket
  ): Promise<CapCutQrLoginPollResult> {
    try {
      const session = await this.establishSession(ticket.loginHost);
      await this.persistSession(session);

      return {
        status: 'confirmed',
        rawStatus: 'confirmed',
        authenticated: true,
        session,
      };
    } catch (error) {
      if (
        this.activateFallbackRegion(
          error,
          'CapCut QR workspace validation'
        )
      ) {
        try {
          const session = await this.establishSession(ticket.loginHost);
          await this.persistSession(session);

          return {
            status: 'confirmed',
            rawStatus: 'confirmed',
            authenticated: true,
            session,
          };
        } catch (fallbackError) {
          await this.persistSession(null);

          return {
            status: 'confirmed',
            rawStatus: 'confirmed',
            authenticated: true,
            warning: `QR login cookies were saved, but workspace validation still failed: ${formatError(
              fallbackError
            )}`,
          };
        }
      }

      await this.persistSession(null);

      return {
        status: 'confirmed',
        rawStatus: 'confirmed',
        authenticated: true,
        warning: `QR login cookies were saved, but workspace validation still failed: ${formatError(
          error
        )}`,
      };
    }
  }

  private async establishSession(loginHost: string): Promise<CapCutSessionState> {
    const accountInfo = await this.fetchAccountInfo().catch((error) => {
      logger.info('CapCut account info lookup failed after QR login', {
        error,
      });
      return null;
    });
    const workspace = await this.fetchPrimaryWorkspace();

    return {
      userId: normalizeStringId(accountInfo?.user_id) ?? '',
      screenName: normalizeString(accountInfo?.screen_name) ?? '',
      workspaceId: workspace.workspace_id,
      loginHost,
      verifyFp: this.verifyFp,
      deviceId: this.deviceId,
      loggedInAt: Date.now(),
      verifiedAt: Date.now(),
    };
  }

  private async fetchAccountInfo(): Promise<AccountInfo> {
    return unwrapJsonResponse<AccountInfo>(
      await getAccountInfo({
        requester: this.fetchWithCookies.bind(this),
        path: '/passport/web/account/info/',
        searchParams: this.loginSearchParams(),
        headers: this.loginHeaders(),
      }),
      'CapCut account info'
    );
  }

  private async fetchPrimaryWorkspace() {
    let lastError: unknown;
    const retryDelaysMs = [1200, 3000, 7000, 12000];

    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      try {
        return await this.requestSignedEditJson<WorkspaceListResponse>({
          path: '/cc/v1/workspace/get_user_workspaces',
          appVersion: webAppVersion,
          searchParams: {
            aid: appId,
            device_platform: 'web',
            region: this.regionProfile.region,
            web_id: this.deviceId,
          },
          extraHeaders: {
            lan: this.regionProfile.locale,
            loc: 'sg',
          },
          body: {
            cursor: '0',
            count: 100,
            need_convert_workspace: true,
          },
          request: ({ searchParams, headers, body }) =>
            getUserWorkspaces({
              requester: this.fetchWithCookies.bind(this),
              path: '/cc/v1/workspace/get_user_workspaces',
              searchParams,
              headers,
              body,
            }),
          context: 'CapCut workspace list',
        }).then((data) => {
          const workspaces = Array.isArray(data.workspace_infos)
            ? data.workspace_infos
            : [];
          const workspace =
            workspaces.find((item) => item.role === 'owner') ?? workspaces[0];

          if (!workspace?.workspace_id) {
            throw new Error('CapCut workspace list was empty');
          }

          return workspace;
        });
      } catch (error) {
        lastError = error;

        if (attempt >= retryDelaysMs.length || !shouldRetryWorkspaceList(error)) {
          break;
        }

        await wait(retryDelaysMs[attempt]);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('CapCut workspace list failed');
  }

  private async requestSignedEditJson<T>(options: {
    path: string;
    appVersion: string;
    body: unknown;
    searchParams?: Record<string, string>;
    extraHeaders?: Record<string, string>;
    request: (params: {
      searchParams: Record<string, string>;
      headers: Headers;
      body: string;
    }) => Promise<Response>;
    context: string;
  }) {
    if (this.runtimeEditorBundleConfig.sourceUrls.length === 0) {
      this.runtimeEditorBundleConfig =
        await capCutBundleService.resolveEditorBundleConfig(
          this.fetchWithCookies.bind(this)
        );
    }

    const searchParams = options.searchParams ?? {};
    const targetUrl = new URL(options.path, env.CAPCUT_EDIT_API_URL);

    for (const [key, value] of Object.entries(searchParams)) {
      targetUrl.searchParams.set(key, value);
    }

    const recipe = this.runtimeEditorBundleConfig.signRecipe;
    const tdid = this.tdid ?? recipe?.tdidDefault ?? '';
    const resolvedPlatformId = recipe?.platformId ?? platformId;
    const resolvedSignVersion = recipe?.signVersion ?? signVersion;
    const { sign, deviceTime } = createEditApiSignature(
      targetUrl.toString(),
      resolvedPlatformId,
      options.appVersion,
      tdid,
      recipe
    );

    return unwrapJsonResponse<T>(
      await options.request({
        searchParams,
        headers: new Headers({
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          Origin: env.CAPCUT_WEB_URL,
          Referer: `${env.CAPCUT_WEB_URL}/`,
          'User-Agent': env.USER_AGENT,
          appid: appId,
          appvr: options.appVersion,
          'device-time': deviceTime,
          did: this.deviceId,
          pf: resolvedPlatformId,
          sign,
          'sign-ver': resolvedSignVersion,
          'store-country-code': this.regionProfile.storeCountryCode,
          'store-country-code-src': 'uid',
          tdid,
          ...options.extraHeaders,
        }),
        body: JSON.stringify(options.body),
      }),
      options.context
    );
  }

  private async restorePersistedSession() {
    if (this.restored) {
      return;
    }

    this.restored = true;

    try {
      const raw = await fs.readFile(this.sessionStorePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedSessionState;

      if (Array.isArray(parsed.cookies)) {
        this.cookieJar.hydrate(parsed.cookies);
      }

      if (!env.CAPCUT_DEVICE_ID && parsed.deviceId) {
        this.deviceId = parsed.deviceId;
      }

      if (!env.CAPCUT_VERIFY_FP && parsed.verifyFp) {
        this.verifyFp = parsed.verifyFp;
      }

      if (!env.CAPCUT_TDID && parsed.tdid) {
        this.tdid = parsed.tdid;
      }

      this.syncDeviceIdFromCookies();
    } catch (error) {
      const code =
        error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : null;

      if (code !== 'ENOENT') {
        logger.warn('Failed to restore persisted CapCut QR session', { error });
      }
    }
  }

  private async persistSession(session: CapCutSessionState | null) {
    await fs.mkdir(path.dirname(this.sessionStorePath), { recursive: true });

    const payload: PersistedSessionState = {
      session,
      cookies: this.cookieJar.serialize(),
      verifyFp: this.verifyFp,
      deviceId: this.deviceId,
      tdid: this.tdid,
    };

    await fs.writeFile(
      this.sessionStorePath,
      JSON.stringify(payload, null, 2),
      'utf8'
    );
  }

  private async primeCookies() {
    const response = await getLoginPage({
      requester: this.fetchWithCookies.bind(this),
      path: `/${this.regionProfile.pageLocale}/login`,
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': this.regionProfile.locale,
        'User-Agent': env.USER_AGENT,
      },
    });

    this.syncDeviceIdFromCookies();

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `CapCut login page bootstrap failed: ${response.status} ${response.statusText} ${getResponseBodySnippet(
          body
        )}`
      );
    }
  }

  private async requestLoginApi(
    apiPath: string,
    searchParams: Record<string, string>
  ) {
    return CapCutLoginApiClient.request({
      requester: this.fetchWithCookies.bind(this),
      host: env.CAPCUT_LOGIN_HOST,
      path: apiPath,
      method: 'GET',
      searchParams: {
        ...this.loginSearchParams(),
        ...searchParams,
      },
      headers: this.loginHeaders(),
    });
  }

  private async fetchWithCookies(url: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    const cookieHeader = this.cookieJar.getCookieHeader(url);

    if (cookieHeader) {
      headers.set('Cookie', cookieHeader);
    }

    const response = await fetch(url, {
      ...init,
      headers,
    });

    this.cookieJar.storeFromResponse(response, url);
    this.syncDeviceIdFromCookies();

    return response;
  }

  private loginSearchParams() {
    return {
      aid: appId,
      account_sdk_source: 'web',
      sdk_version: loginSdkVersion,
      language: this.regionProfile.locale,
      verifyFp: this.verifyFp,
    };
  }

  private loginHeaders() {
    return {
      Accept: 'application/json, text/javascript',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': env.USER_AGENT,
      appid: appId,
      did: this.deviceId,
      Origin: env.CAPCUT_WEB_URL,
      Referer: `${env.CAPCUT_WEB_URL}/${this.regionProfile.pageLocale}/login`,
      'store-country-code': this.regionProfile.storeCountryCode,
      'store-country-code-src': 'uid',
      'x-tt-passport-csrf-token':
        this.getPassportCsrfToken(env.CAPCUT_LOGIN_HOST) ?? '',
    };
  }

  private seedPassportCookies() {
    const csrf =
      this.getPassportCsrfToken(env.CAPCUT_LOGIN_HOST) ??
      crypto.randomBytes(16).toString('hex');
    const domains = [
      new URL(env.CAPCUT_WEB_URL).hostname,
      new URL(env.CAPCUT_LOGIN_HOST).hostname,
      new URL(env.CAPCUT_FALLBACK_LOGIN_HOST).hostname,
    ];

    for (const domain of domains) {
      this.cookieJar.set('passport_csrf_token', csrf, domain);
      this.cookieJar.set('passport_csrf_token_default', csrf, domain);
    }
  }

  private getPassportCsrfToken(url: string) {
    return (
      this.cookieJar.get('passport_csrf_token', url) ??
      this.cookieJar.get('passport_csrf_token_default', url)
    );
  }

  private hasAuthenticatedCookies() {
    return (
      this.cookieJar.get('sessionid', env.CAPCUT_WEB_URL) ??
      this.cookieJar.get('sessionid_ss', env.CAPCUT_WEB_URL) ??
      this.cookieJar.get('sid_tt', env.CAPCUT_WEB_URL) ??
      this.cookieJar.get('uid_tt', env.CAPCUT_WEB_URL)
    );
  }

  private syncDeviceIdFromCookies() {
    if (env.CAPCUT_DEVICE_ID) {
      return;
    }

    const cookieDeviceId =
      this.cookieJar.get('_tea_web_id') ??
      this.cookieJar.get('_tea_web_id', env.CAPCUT_WEB_URL) ??
      this.cookieJar.get('_tea_web_id', env.CAPCUT_LOGIN_HOST) ??
      this.cookieJar.get('web_id') ??
      this.cookieJar.get('did');

    if (cookieDeviceId) {
      this.deviceId = cookieDeviceId;
    }
  }

  private isExpired(ticket: CapCutQrLoginTicket) {
    return Boolean(ticket.expireTime && Date.now() >= ticket.expireTime * 1000);
  }
}

const normalizeStatus = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'new';

const isCompletedQrStatus = (status: string) =>
  ['confirmed', 'confirm', 'success', 'done', 'authorized', 'login_success'].some(
    (value) => status.includes(value)
  );

const isFailedQrStatus = (status: string) =>
  ['expired', 'expire', 'timeout', 'cancel', 'failed', 'error'].some((value) =>
    status.includes(value)
  );

const getSetCookieHeaders = (response: Response): string[] => {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };

  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const header = response.headers.get('set-cookie');
  return header ? [header] : [];
};

const getSetCookieNames = (response: Response) =>
  getSetCookieHeaders(response)
    .map((header) => header.split(';')[0]?.split('=')[0]?.trim())
    .filter((name): name is string => Boolean(name));

const normalizeString = (value: unknown) =>
  typeof value === 'string' ? value : null;

const normalizeStringId = (value: unknown) =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'bigint'
    ? String(value)
    : null;

const shouldRetryWorkspaceList = (error: unknown) =>
  error instanceof CapCutApiError &&
  error.message.toLowerCase().includes('system busy');

const formatError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export default new CapCutQrLoginService();
