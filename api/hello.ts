export default {
  fetch(): Response {
    return Response.json({ ok: true, now: new Date().toISOString() });
  },
};
