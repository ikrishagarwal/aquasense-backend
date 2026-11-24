import fp from 'fastify-plugin';
import { config } from '../config.js';
import { createFcmSender } from '../lib/fcm.js';

export default fp(async app => {
  const sendAlert = config.FCM_SERVICE_ACCOUNT_PATH ? createFcmSender(config.FCM_SERVICE_ACCOUNT_PATH) : null;

  async function dispatch() {
    if (!app.mqtt.isConnected()) return;
    const { data: rows, error } = await app.supabase.rpc('claim_drain_dispatch');
    if (error) throw Error('Drain dispatch claim failed');
    const command = rows?.[0];
    if (!command) return;
    const { id, device_id, issued_at, expires_at, duration_s } = command;
    const expiry = Date.parse(expires_at);
    if (expiry <= Date.now()) return;
    await app.mqtt.publish(`purifier/${device_id}/cmd`, {
      schema_version: 1, command_id: id, device_id, type: 'drain',
      issued_at: new Date(issued_at).toISOString(), expires_at: new Date(expiry).toISOString(), duration_s,
    }, expiry);
    const { error: updateError } = await app.supabase.from('command_logs')
      .update({ broker_delivered_at: new Date().toISOString() }).eq('id', id).is('broker_delivered_at', null);
    if (updateError) throw Error('Drain broker delivery record failed');
  }

  async function deliverAlert() {
    if (!sendAlert) return;
    const { data: rows, error } = await app.supabase.rpc('claim_alert_delivery');
    if (error) throw Error('Alert delivery claim failed');
    const job = rows?.[0];
    if (!job) return;
    let outcome: string;
    try {
      outcome = job.token ? await sendAlert(job.token, job.payload) : 'recipient_removed';
    } catch {
      const delaySeconds = Math.min(3600, 60 * 2 ** (job.attempts - 1));
      const retry = await app.supabase.from('alert_deliveries')
        .update({ next_attempt_at: new Date(Date.now() + delaySeconds * 1000).toISOString() })
        .eq('id', job.id).eq('attempts', job.attempts);
      if (retry.error) throw Error('Alert retry scheduling failed');
      throw Error('Alert send failed and will be retried');
    }
    const result = await app.supabase.rpc('finish_alert_delivery', {
      p_id: job.id, p_attempts: job.attempts, p_outcome: outcome,
    });
    if (result.error) throw Error('Alert delivery recording failed');
  }

  function schedule(work: () => Promise<void>, interval: number) {
    let running: Promise<void> | undefined;
    let timer: NodeJS.Timeout;
    app.addHook('onReady', async () => {
      timer = setInterval(() => {
        if (running) return;
        running = work().catch(error => app.log.warn({ message: error.message }, 'Edge worker failed'))
          .finally(() => { running = undefined; });
      }, interval);
      timer.unref();
    });
    app.addHook('onClose', async () => {
      clearInterval(timer);
      await running;
    });
  }

  app.addHook('onReady', async () => {
    if (!sendAlert) app.log.warn('FCM is unconfigured; alert jobs will remain queued');
  });
  schedule(dispatch, 250);
  if (sendAlert) schedule(deliverAlert, 500);
});
