// A build without a sign-in provider can never unlock a paid feature. Mark the
// document so dashboard-fixes.css hides locked panels and upsell controls. The
// gates themselves are untouched, and the mark goes away if access is granted
// some other way (a tester or self-host key).
import { isClerkAuthEnabled } from '@/services/clerk';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { onEntitlementChange } from '@/services/entitlements';
import { hasPremiumAccess } from '@/services/panel-gating';
import { subscribeWidgetAccess } from '@/services/widget-store';
import '@/shell/dashboard-fixes.css';

export const KEYLESS_CLASS = 'bansho-keyless';

export function installKeylessChrome(): () => void {
  const apply = (): void => {
    const keyless = !isClerkAuthEnabled() && !hasPremiumAccess(getAuthState());
    document.documentElement.classList.toggle(KEYLESS_CLASS, keyless);
  };
  apply();
  const unsubscribes = [
    subscribeAuthState(apply),
    onEntitlementChange(apply),
    subscribeWidgetAccess(apply),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    document.documentElement.classList.remove(KEYLESS_CLASS);
  };
}
