import { auditEntitlement } from './release-entitlements.js';

// Reuse the subscription resolver used by Chat/Advanced/Audit; never resolve
// identity, plan or overrides from the extension's request body.
export function createConversationAudioEntitlement({resolveSubscription,isUnlimited,env=process.env}) {
  return async auth => {
    if (!auth?.userId || !auth.email) throw new Error('audio_unauthenticated');
    const identity={userId:auth.userId,email:auth.email,identitySource:auth.identitySource};
    const user=await resolveSubscription(identity);
    const staging=env.SUPABASE_URL==='https://qfwmjgoiwketpkuhvixm.supabase.co'
      && env.RENDER_EXTERNAL_HOSTNAME==='zentra-backend-v2-staging.onrender.com';
    const unlimited=staging && isUnlimited(identity.email)===true && user?.unlimited_agency===true;
    // The legacy override may exist elsewhere; audio must not propagate it there.
    if (user?.unlimited_agency && !unlimited) throw new Error('audio_entitlement_unavailable');
    return {plan:auditEntitlement(user).plan,unlimited};
  };
}
