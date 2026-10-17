// Commercial denials are structured; they are not provider or quota errors.
export function sendFreeAccessBlock(res, reservation) {
  if (reservation?.reason !== 'free_access_blocked' || !reservation.commercial) return false;
  res.status(403).json({ success: false, code: 'free_access_blocked', commercial: reservation.commercial });
  return true;
}

export function createFreeNotifyHandler({ client }) {
  return async (req, res) => {
    try {
      const { data, error } = await client.rpc('zentra_free_notify', {
        p_auth_id: req.auth.userId, p_email: req.auth.email
      });
      if (error || data?.success !== true) throw new Error('Preference unavailable');
      return res.json(data);
    } catch (_) {
      return res.status(503).json({ code: 'free_preference_unavailable', error: 'No se pudo guardar el aviso. Intenta nuevamente.' });
    }
  };
}
