// Read-only recovery. Do not use zentra_access/read_chat_steps here: they can
// refresh billing cycles, create users and recover/refund reservations.
export function createChatStatusHandler({ client, now = Date.now }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.auth?.userId) return res.status(401).json({ error: 'Iniciá sesión para continuar.' });
    const id = req.query?.operationId;
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ error: 'La solicitud no es válida.' });
    }
    try {
      const userResult = await client.from('users').select('id')
        .eq('auth_user_id', req.auth.userId).eq('plan_type', 'subscription').maybeSingle();
      if (userResult.error) throw userResult.error;
      if (!userResult.data) return res.json({ status: 'not_found' });
      const result = await client.from('zentra_requests')
        .select('state,response,lease_until,provider_started_at,created_at')
        .eq('user_id', userResult.data.id).eq('operation_key', id).eq('kind', 'chat')
        .order('created_at', { ascending: false }).limit(10);
      if (result.error) throw result.error;
      const rows = result.data || [];
      const running = rows.filter(row => row.state === 'running');
      // A provider-started expired lease is uncertain, never permission to replay.
      const uncertain = running.some(row => Date.parse(row.lease_until) <= now() && row.provider_started_at);
      const active = running.some(row => Date.parse(row.lease_until) > now());
      const status = uncertain ? 'uncertain' : active ? 'running' :
        !rows.length ? 'not_found' : rows[0].state === 'done' ? 'complete' : 'failed';
      const completed = rows.find(row => row.state === 'done' && row.response);
      // Only the same authenticated user's public result, not stored prompts,
      // account data, lease tokens or provider credentials.
      const response = completed?.response?.body?.response ?? completed?.response?.text;
      const publicResult = { success: true, response };
      for (const key of ['raw_content', 'analysis', 'output_text', 'content']) {
        const value = completed?.response?.body?.[key];
        if (typeof value === 'string' || (value && typeof value === 'object')) publicResult[key] = value;
      }
      return res.json({ status, ...(response != null ? { response, result: publicResult, partial: status !== 'complete' } : {}) });
    } catch (_) {
      return res.status(503).json({ error: 'No pude comprobar el estado de la respuesta. Intentá nuevamente.' });
    }
  };
}
