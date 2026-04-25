import { CapCutEditApiClient } from '@/api/capcut-edit/apiClient';
import type { ApiRequester } from '@/types/api';

interface GetUserWorkspacesParams {
  requester: ApiRequester;
  path?: string;
  searchParams?: Record<string, string>;
  headers: HeadersInit;
  body: BodyInit;
}

/**
 * ワークスペース一覧を取得する
 */
export const getUserWorkspaces = ({
  requester,
  path,
  searchParams,
  headers,
  body,
}: GetUserWorkspacesParams) =>
  CapCutEditApiClient.request({
    requester,
    path: path ?? '/cc/v1/workspace/get_user_workspaces',
    searchParams,
    method: 'POST',
    headers,
    body,
  });
