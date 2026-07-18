/** Tenant-agent Product Run scope helpers (consumer workspace isolation). */

export interface TenantDelegationScope {
  sessionId: string;
  token: string;
  consumerWorkspaceId: string;
  agentSlug: string;
  /** Consumer-scoped wses_ session bootstrapped at serve time (EmailGate equivalent). */
  workspaceSessionId?: string;
  /** Workspace owner email used for the bootstrapped session. */
  email?: string;
}

export function getTenantDelegationScope(): TenantDelegationScope | null {
  if (typeof window === 'undefined') return null;

  const injected = (window as Window & { __TENANT_DELEGATION__?: TenantDelegationScope })
    .__TENANT_DELEGATION__;
  if (
    injected?.sessionId &&
    injected?.token &&
    injected?.consumerWorkspaceId &&
    injected?.agentSlug
  ) {
    return injected;
  }

  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('ta_session');
  const token = params.get('delegation_token');
  if (!sessionId || !token) return null;

  return {
    sessionId,
    token,
    consumerWorkspaceId: '',
    agentSlug: '',
  };
}

/** True when Product Run / tenant delegation credentials are present. */
export function hasTenantDelegationAuth(): boolean {
  const scope = getTenantDelegationScope();
  if (scope?.sessionId && scope?.token) return true;
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return !!(params.get('ta_session') && params.get('delegation_token'));
}

/** localStorage key for space visitor sessions — scoped per consumer in delegation. */
export function scopedSpaceSessionStorageKey(spaceId: string): string {
  const scope = getTenantDelegationScope();
  const consumerWorkspaceId = scope?.consumerWorkspaceId?.trim();
  if (consumerWorkspaceId) {
    return `space_session_${spaceId}__consumer_${consumerWorkspaceId}`;
  }
  return `space_session_${spaceId}`;
}

/** Auth fields for space chat APIs when running under tenant delegation. */
export function getDelegationChatRequestExtras(): {
  delegationToken: string;
  taSessionId: string;
} | null {
  const scope = getTenantDelegationScope();
  if (!scope?.token || !scope.sessionId) return null;
  return {
    delegationToken: scope.token,
    taSessionId: scope.sessionId,
  };
}
