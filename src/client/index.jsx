import { useSyncExternalStore } from 'react';
import { Checkbox, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import { createController, providerRows, selectedProviders, toggleProvider } from './state.mjs';

const NS = 'dsh-tls-fallback';
const dictionaries = {
  en: {
    title: 'TLS connection fallback', enabled: 'Enable TLS connection fallback',
    description: 'Race verified TLS connections across DNS addresses for selected providers. Model requests are not duplicated and proxy settings remain unchanged.',
    providers: 'LLM providers', hint: 'Changes save automatically. With no providers selected, fallback is inactive.',
    unavailable: 'Unavailable — selection preserved', empty: 'No active LLM providers.', loading: 'Loading…',
    providerError: 'Could not load providers.', retry: 'Retry', saving: 'Saving…',
    conflict: 'Changes were not accepted. Settings have been refreshed; review them and try again.',
    saveError: 'Could not save settings. Review the current values and try again.',
    readOnly: 'Settings are unavailable or read-only in this connection.',
  },
  ru: {
    title: 'Резервное TLS-подключение', enabled: 'Включить резервное TLS-подключение',
    description: 'Параллельная проверка защищённых TLS-соединений с DNS-адресами выбранных провайдеров. Запросы к моделям не дублируются, настройки прокси не меняются.',
    providers: 'LLM-провайдеры', hint: 'Изменения сохраняются автоматически. Если ничего не выбрано, резервное подключение не используется.',
    unavailable: 'Недоступен — выбор сохранён', empty: 'Нет активных LLM-провайдеров.', loading: 'Загрузка…',
    providerError: 'Не удалось загрузить провайдеров.', retry: 'Повторить', saving: 'Сохранение…',
    conflict: 'Изменения не приняты. Настройки обновлены; проверьте их и повторите попытку.',
    saveError: 'Не удалось сохранить настройки. Проверьте текущие значения и повторите попытку.',
    readOnly: 'Настройки недоступны или доступны только для чтения в этом подключении.',
  },
  zh: {
    title: 'TLS 连接回退', enabled: '启用 TLS 连接回退',
    description: '为选定的提供商并行尝试 DNS 地址的已验证 TLS 连接。不会重复发送模型请求，也不会更改代理设置。',
    providers: 'LLM 提供商', hint: '更改会自动保存。未选择提供商时，回退功能不生效。',
    unavailable: '不可用 — 已保留选择', empty: '没有活动的 LLM 提供商。', loading: '加载中…',
    providerError: '无法加载提供商。', retry: '重试', saving: '保存中…',
    conflict: '更改未被接受。设置已刷新；请检查后重试。',
    saveError: '无法保存设置。请检查当前值后重试。',
    readOnly: '此连接中的设置不可用或为只读。',
  },
};

function SettingsSection({ controller, locale, t }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useSyncExternalStore(callback => locale.subscribe(callback), () => locale.getSnapshot());
  const { form, busy } = state;
  const selected = selectedProviders(form.value?.providers);
  const rows = providerRows(state.active, selected);
  const disabled = busy || !form.writable || form.status !== 'ready';
  const save = (field, value) => controller.save(field, value, form.revision);
  return <section aria-label={t('title')} style={{ display: 'grid', gap: 16, maxWidth: 720 }}>
    <h2 style={{ margin: 0 }}>{t('title')}</h2>
    <p style={{ margin: 0, lineHeight: 1.5 }}>{t('description')}</p>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
      <span>{t('enabled')}</span>
      <Switch label={t('enabled')} checked={form.value?.enabled ?? true} disabled={disabled}
        onChange={checked => save('enabled', checked)} />
    </div>
    {form.status === 'loading' ? <p role="status">{t('loading')}</p>
      : !form.writable && <p role="status">{t('readOnly')}</p>}
    <fieldset disabled={disabled} style={{ margin: 0, padding: 0, border: 0, display: 'grid', gap: 12 }}>
      <legend style={{ marginBottom: 12, fontWeight: 600 }}>{t('providers')}</legend>
      {rows.map(row => <div key={row.id} style={{ display: 'grid', gap: 4 }}>
        <Checkbox checked={selected.includes(row.id)} disabled={disabled}
          label={`${row.name}${row.name !== row.id ? ` (${row.id})` : ''}${row.available ? '' : ` — ${t('unavailable')}`}`}
          onChange={checked => save('providers', toggleProvider(selected, row.id, checked))} />
      </div>)}
      {!state.loading && !state.providerError && rows.length === 0 && <p>{t('empty')}</p>}
    </fieldset>
    <p style={{ margin: 0, lineHeight: 1.5 }}>{t('hint')}</p>
    {state.loading && <p role="status">{t('loading')}</p>}
    {state.providerError && <div role="alert">{t('providerError')} <button type="button" onClick={() => controller.load()}>{t('retry')}</button></div>}
    {state.writeError && <p role="alert">{t(state.writeError)}</p>}
    {busy && <p role="status">{t('saving')}</p>}
  </section>;
}

export const inject = ['slots', 'locale', 'remote', 'remote.llm', 'configForms'];
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'tls-fallback: locale');
  const t = ctx.locale.bind(NS);
  const controller = createController(ctx);
  ctx.effect(() => {
    const reload = () => { void controller.load(); };
    const disposers = [ctx.remote.$on('llm/adapters-updated', reload), ctx.on('connection/reset', reload)];
    reload();
    return () => { for (const dispose of disposers) dispose(); controller.dispose(); };
  }, 'tls-fallback: provider list');
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: NS, order: 80, label: () => t('title'),
    inject: () => ({ controller, locale: ctx.locale, t }),
  }, SettingsSection));
}
