export default {
  fetch(): Response {
    const now = new Date().toISOString();
    console.log(`[cron-ping] fired at ${now}`);
    return Response.json({ ok: true, now });
  },
};
