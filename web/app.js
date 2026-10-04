const state = {
  plans: [],
  executions: []
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let planFilter = 'all';
let editingPlanId = null;
const pendingRuns = new Set();
const runResults = new Map();

function renderRunResults() {
  $$('.full-plan-card').forEach((card) => {
    const id = card.dataset.id;
    const button = card.querySelector('.run-now');
    if (button) {
      button.disabled = pendingRuns.has(id);
      button.textContent = pendingRuns.has(id) ? '提交中…' : '立即投入';
    }
    let feedback = card.querySelector('.run-feedback');
    const result = runResults.get(id);
    if (!result) { feedback?.remove(); return; }
    if (!feedback) {
      feedback = document.createElement('p');
      feedback.setAttribute('role', 'status');
      card.appendChild(feedback);
    }
    feedback.className = 'run-feedback ' + result.type;
    feedback.textContent = result.message;
  });
}

function coinFor(pair) {
  const value = String(pair || '').toUpperCase();
  if (value.startsWith('BTC')) return { coin: 'btc', symbol: '₿' };
  if (value.startsWith('ETH')) return { coin: 'eth', symbol: '◆' };
  if (value.startsWith('SOL')) return { coin: 'sol', symbol: '≋' };
  return { coin: 'generic', symbol: '◈' };
}

function displayPair(pair) {
  const symbol = String(pair || '').replace(/[\/\s_-]/g, '').toUpperCase();
  return symbol.endsWith('USDT') ? symbol.slice(0, -4) + ' / USDT' : symbol;
}

function amountValue(value) {
  const parsed = Number(String(value ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function executionDate(item) {
  const date = item.createdAt ? new Date(item.createdAt) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function isCurrentMonth(date) {
  const now = new Date();
  return date && date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
}

function confirmedInvestment(item) {
  if (['filled', 'completed', 'success'].includes(item.status)) {
    return Math.max(0, amountValue(item.filledQuoteAmount) || amountValue(item.amount));
  }
  if (item.status === 'submitted') return Math.max(0, amountValue(item.amount));
  return 0;
}

function formatNextRun(date) {
  if (!date || Number.isNaN(date.getTime())) return '暂无';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function countdownText(date) {
  if (!date || Number.isNaN(date.getTime())) return '—';
  const seconds = Math.max(0, Math.floor((date.getTime() - Date.now()) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `还有 ${days}天${hours}时`;
  if (hours) return `还有 ${hours}时${minutes}分`;
  return `还有 ${minutes}分`;
}

function renderTodayLabel() {
  const today = $('#today-label');
  if (!today) return;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  today.textContent = `${parts.year}年${parts.month}月${parts.day}日${parts.weekday} · ${parts.hour}:${parts.minute} · GMT+8`;
  const hour = Number(parts.hour);
  const greeting = hour >= 5 && hour < 12 ? '早上好' : hour >= 12 && hour < 18 ? '下午好' : '晚上好';
  const greetingNode = $('#greeting-label');
  if (greetingNode) greetingNode.textContent = greeting;
}

function renderDashboard() {
  const plans = state.plans;
  const runningPlans = plans.filter((plan) => plan.enabled !== false);
  const executions = state.executions;
  const confirmed = executions.filter((item) => confirmedInvestment(item) > 0);
  const monthExecutions = confirmed.filter((item) => isCurrentMonth(executionDate(item)));
  const monthlyAmount = monthExecutions.reduce((sum, item) => sum + confirmedInvestment(item), 0);
  const accumulatedAmount = confirmed.reduce((sum, item) => sum + confirmedInvestment(item), 0);
  const nextPlan = runningPlans
    .map((plan) => ({ plan, date: plan.nextRunAt ? new Date(plan.nextRunAt) : null }))
    .filter((item) => item.date && !Number.isNaN(item.date.getTime()))
    .sort((a, b) => a.date - b.date)[0];
  const monthlyNode = $('#monthly-investment');
  if (monthlyNode) monthlyNode.innerHTML = `${monthlyAmount.toFixed(2)} <small>USDT</small>`;
  const monthlyNote = $('#monthly-investment-note');
  if (monthlyNote) monthlyNote.textContent = monthExecutions.length ? `${monthExecutions.length} 笔实盘成交` : '暂无实盘成交';
  const accumulatedNode = $('#accumulated-buy');
  if (accumulatedNode) accumulatedNode.innerHTML = `${accumulatedAmount.toFixed(2)} <small>USDT</small>`;
  const accumulatedNote = $('#accumulated-buy-note');
  if (accumulatedNote) accumulatedNote.textContent = confirmed.length ? `${confirmed.length} 笔实盘成交金额` : '暂无实盘成交（待成交订单不计入）';
  const runningNode = $('#running-plan-total');
  if (runningNode) runningNode.innerHTML = `${runningPlans.length} <small>个</small>`;
  const runningNote = $('#running-plan-note');
  if (runningNote) runningNote.textContent = runningPlans.length ? `${runningPlans.length} 个计划已启用` : '暂无运行中的计划';
  const nextValue = $('#next-run-value');
  if (nextValue) nextValue.textContent = nextPlan ? formatNextRun(nextPlan.date) : '暂无';
  const nextNote = $('#next-run-note');
  if (nextNote) nextNote.textContent = nextPlan ? `${displayPair(nextPlan.plan.pair)} · ${nextPlan.plan.frequency}` : '暂无排期';
  const countdown = $('#next-run-countdown');
  if (countdown) countdown.textContent = nextPlan ? countdownText(nextPlan.date) : '—';
  renderTodayLabel()
  const upcoming = $('#upcoming-events');
  if (upcoming) {
    const items = runningPlans
      .map((plan) => ({ plan, date: plan.nextRunAt ? new Date(plan.nextRunAt) : null }))
      .filter((item) => item.date && !Number.isNaN(item.date.getTime()) && item.date >= new Date() && item.date <= new Date(Date.now() + 7 * 86400000))
      .sort((a, b) => a.date - b.date)
      .slice(0, 5);
    upcoming.innerHTML = items.length ? items.map(({ plan, date }) => `<div class="next-event"><div class="event-date"><b>${String(date.getDate()).padStart(2, '0')}</b><span>${date.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}</span></div><div class="event-info"><strong>${displayPair(plan.pair)}</strong><span>${plan.frequency} · ${Number(plan.amount).toFixed(2)} USDT</span><em>${countdownText(date)}</em></div></div>`).join('') : '<div class="empty-state"><strong>暂无排期</strong><span>创建并启用定投计划后会显示在这里。</span></div>';
  }
  const totalNode = $('#execution-total');
  if (totalNode) totalNode.textContent = executions.length;
  const successNode = $('#execution-success-rate');
  if (successNode) {
    const settled = executions.filter((item) => ['filled', 'completed', 'success', 'failed'].includes(item.status));
    const successful = settled.filter((item) => item.status !== 'failed').length;
    successNode.textContent = settled.length ? `${Math.round(successful / settled.length * 100)}%` : '—';
  }
  const investmentNode = $('#execution-investment-total');
  if (investmentNode) investmentNode.innerHTML = `${accumulatedAmount.toFixed(2)} <small>USDT</small>`;
}

function renderPlanRow(plan) {
  return `<div class="plan-row"><span class="coin-icon ${plan.coin}">${plan.symbol}</span><div class="plan-row-info"><strong>${plan.name}</strong><span>${displayPair(plan.pair)} · ${plan.frequency}</span></div><div class="plan-row-amount"><strong>${Number(plan.amount).toFixed(2)} USDT</strong><span>下次：${plan.next}</span></div><i class="status-dot"></i></div>`;
}

function renderFullPlan(plan) {
  const enabled = plan.enabled !== false;
  const planExecutions = state.executions.filter((item) => String(item.planId || '') === String(plan.id));
  const monthAmount = planExecutions.filter((item) => isCurrentMonth(executionDate(item))).reduce((sum, item) => sum + confirmedInvestment(item), 0);
  return `<article class="full-plan-card" data-id="${plan.id}" data-plan="${plan.name.toLowerCase()} ${displayPair(plan.pair).toLowerCase()}"><div class="card-top"><span class="coin-icon ${plan.coin}">${plan.symbol}</span><div class="card-title"><strong>${plan.name}</strong><span>${displayPair(plan.pair)}</span></div><div class="plan-menu-wrap"><button class="kebab plan-menu-trigger" aria-label="计划操作" title="计划操作">⋮</button><div class="plan-menu"><button class="edit-plan">修改计划</button><button class="delete-plan">删除计划</button></div></div></div><div class="plan-card-amount">${Number(plan.amount).toFixed(2)} <small>USDT / 次</small></div><div class="plan-card-frequency">${plan.frequency} · ${plan.direction}</div><div class="card-details"><div><span>本月已投入</span><strong>${monthAmount.toFixed(2)} USDT</strong></div><div><span>累计执行</span><strong>${planExecutions.length} 次</strong></div></div><div class="card-footer"><span class="next-run">下次执行：<b>${plan.next || '待安排'}</b></span><div class="plan-actions"><button class="run-now" aria-label="立即投入">立即投入</button><button class="toggle ${enabled ? 'on' : ''}" aria-label="${enabled ? '暂停计划' : '恢复计划'}"><i></i></button></div></div></article>`;
}

function statusMarkup(status) {
  const label = status === 'simulated' ? '历史记录' : status === 'submitted' ? '已提交' : status === 'failed' ? '失败' : '已完成';
  return `<span class="status-pill"><i></i>${label}</span>`;
}

function renderExecutions() {
  const rows = state.executions.map((item) => `<tr><td>${item.time}</td><td>${item.plan}</td><td>${item.pair}</td><td class="direction">↗ 买入</td><td>${item.amount}</td><td>${item.qty}</td><td>${item.price}</td><td>${statusMarkup(item.status)}</td></tr>`).join('');
  $('#overview-execution-table').innerHTML = state.executions.slice(0, 3).map((item) => `<tr><td>${item.time}</td><td>${item.plan}</td><td class="direction">↗ 买入</td><td>${item.amount}</td><td>${item.price}</td><td>${statusMarkup(item.status)}</td></tr>`).join('');
  $('#full-execution-table').innerHTML = rows;
  renderPlans();
}

function renderPlans() {
  const empty = '<div class="empty-state"><strong>暂无定投计划</strong><span>点击右上角“新建定投计划”开始配置。</span></div>';
  const filtered = state.plans.filter((plan) => planFilter === 'all' || (planFilter === 'running' ? plan.enabled !== false : plan.enabled === false));
  const running = state.plans.filter((plan) => plan.enabled !== false).length;
  const paused = state.plans.length - running;
  $('#overview-plan-list').innerHTML = running ? state.plans.filter((plan) => plan.enabled !== false).slice(0, 3).map(renderPlanRow).join('') : empty;
  $('#full-plan-list').innerHTML = filtered.length ? filtered.map(renderFullPlan).join('') : empty;
  $('#plan-count').textContent = state.plans.length;
  $('#all-count').textContent = state.plans.length;
  $('#running-count').textContent = running;
  $('#paused-count').textContent = paused;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.planFilter === planFilter));
  applyPlanSearch();
  renderRunResults();
  renderDashboard();
}

function applyPlanSearch() {
  const query = $('#plan-search')?.value.trim().toLowerCase() || '';
  $$('.full-plan-card').forEach((card) => { card.style.display = card.dataset.plan.includes(query) ? '' : 'none'; });
}

function showToast(message) {
  $('#toast-message').textContent = message;
  $('#toast').classList.add('show');
  setTimeout(() => $('#toast').classList.remove('show'), 2400);
}

function csvCell(value) {
  return '"' + String(value ?? '').replaceAll('"', '""') + '"';
}

function exportExecutionsCsv() {
  const headers = ['执行时间', '计划', '交易对', '方向', '设定金额', '成交数量', '成交均价', '状态', '订单号'];
  const statusLabels = { submitted: '已提交', failed: '失败', simulated: '历史记录', filled: '已完成', completed: '已完成', success: '已完成' };
  const rows = state.executions.map((item) => [
    item.time || '', item.plan || '', item.pair || '', '买入', item.amount || '', item.qty || '',
    item.price || '', statusLabels[item.status] || item.status || '', item.orderId || ''
  ]);
  const csv = '\ufeff' + [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  link.href = url;
  link.download = `orbit-dca-executions-${stamp}.csv`;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(rows.length ? `已导出 ${rows.length} 条执行记录` : '已导出空记录文件');
}

function openModal(plan = null) {
  editingPlanId = plan ? plan.id : null;
  const form = $('#plan-form');
  if (plan) {
    form.elements.name.value = plan.name || '';
    form.elements.pair.value = plan.pair || plan.symbol || '';
    form.elements.amount.value = plan.amount || '';
    form.elements.frequency.value = String(plan.frequency || '').split(' · ')[0] || '每天';
    form.elements.time.value = plan.time || '09:30';
    form.elements.direction.value = 'buy';
    const search = $('#market-search');
    if (search) search.value = displayPair(plan.pair || plan.symbol);
  } else {
    form.reset();
    form.elements.amount.value = 100;
    form.elements.time.value = '09:30';
    $('#plan-modal-title').textContent = '新建定投计划';
    $('#plan-submit-button').textContent = '创建计划';
  }
  if (plan) {
    $('#plan-modal-title').textContent = '修改定投计划';
    $('#plan-submit-button').textContent = '保存修改';
  }
  $('#plan-modal').classList.add('open');
  $('#plan-modal').setAttribute('aria-hidden', 'false');
}
function closeModal() { editingPlanId = null; $('#plan-modal').classList.remove('open'); $('#plan-modal').setAttribute('aria-hidden', 'true'); }
function openApiModal() { $('#api-modal').classList.add('open'); $('#api-modal').setAttribute('aria-hidden', 'false'); }
function closeApiModal() { $('#api-modal').classList.remove('open'); $('#api-modal').setAttribute('aria-hidden', 'true'); $('#api-form').reset(); }

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('orbit.settings') || '{}'); } catch {}
  $$('[data-setting]').forEach((field) => {
    if (saved[field.dataset.setting] === undefined) return;
    if (field.type === 'checkbox') field.checked = Boolean(saved[field.dataset.setting]);
    else field.value = saved[field.dataset.setting];
  });
}

async function saveSettings() {
  const saved = {};
  $$('[data-setting]').forEach((field) => { saved[field.dataset.setting] = field.type === 'checkbox' ? field.checked : field.value; });
  localStorage.setItem('orbit.settings', JSON.stringify(saved));
  if (window.orbitApi?.ready) {
    const response = await window.orbitApi.request('/settings/notifications', {
      method: 'POST',
      body: JSON.stringify({
        enabled: Boolean(saved.telegramEnabled),
        botToken: saved.telegramBotToken || '',
        chatId: saved.telegramChatId || '',
        notifyFailures: saved.telegramNotifyFailures !== false
      })
    });
    window.orbitApi.renderNotificationStatus?.(response.data);
  }
}

function switchView(view) {
  $$('.view').forEach((item) => item.classList.toggle('active', item.id === `view-${view}`));
  $$('.nav-item, .settings-link').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  const labels = { overview: '总览', plans: '定投计划', executions: '执行记录', account: '账户与连接', settings: '系统设置' };
  $('#page-label').textContent = labels[view] || '总览';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.addEventListener('click', (event) => {
  const userMenuButton = event.target.closest('#user-menu-button');
  const userDropdown = $('#user-dropdown');
  if (userMenuButton) {
    const open = userDropdown?.hidden !== false;
    if (userDropdown) userDropdown.hidden = !open;
    userMenuButton.setAttribute('aria-expanded', String(open));
    return;
  }
  if (event.target.closest('#logout-button')) {
    const button = event.target.closest('#logout-button');
    button.disabled = true;
    fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
      .catch(() => {})
      .finally(() => { window.location.replace('/login.html'); });
    return;
  }
  if (userDropdown && !event.target.closest('.user-menu-wrap')) {
    userDropdown.hidden = true;
    $('#user-menu-button')?.setAttribute('aria-expanded', 'false');
  }
  const nav = event.target.closest('[data-view]');
  if (nav) switchView(nav.dataset.view);
  if (event.target.closest('#new-plan-button') || event.target.closest('#new-plan-button-2')) openModal();
  const filter = event.target.closest('.tab[data-plan-filter]');
  if (filter) { planFilter = filter.dataset.planFilter; renderPlans(); }
  const settingsTab = event.target.closest('.settings-tab[data-settings-tab]');
  if (settingsTab) {
    const tab = settingsTab.dataset.settingsTab;
    $$('.settings-tab[data-settings-tab]').forEach((item) => item.classList.toggle('active', item === settingsTab));
    $$('[data-settings-panel]').forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== tab; });
  }
  if (event.target.closest('#close-modal') || event.target.closest('#cancel-modal')) closeModal();
  if (event.target === $('#plan-modal')) closeModal();
  if (event.target.closest('#manage-api-key')) {
    if (!window.orbitApi?.ready) { showToast('后端尚未连接'); return; }
    openApiModal();
    return;
  }
  if (event.target.closest('#settings-manage-api')) {
    if (!window.orbitApi?.ready) { showToast('后端尚未连接'); return; }
    openApiModal();
    return;
  }
  if (event.target.closest('#close-api-modal') || event.target.closest('#cancel-api-modal')) closeApiModal();
  if (event.target === $('#api-modal')) closeApiModal();
  const menuTrigger = event.target.closest('.plan-menu-trigger');
  if (menuTrigger) {
    const wrap = menuTrigger.closest('.plan-menu-wrap');
    $$('.plan-menu-wrap').forEach((item) => { if (item !== wrap) item.classList.remove('open'); });
    wrap?.classList.toggle('open');
    return;
  }
  const editButton = event.target.closest('.edit-plan');
  if (editButton) {
    const card = editButton.closest('[data-id]');
    const plan = state.plans.find((item) => String(item.id) === String(card?.dataset.id));
    if (plan) openModal(plan);
    return;
  }
  const deleteButton = event.target.closest('.delete-plan');
  if (deleteButton) {
    const card = deleteButton.closest('[data-id]');
    const id = card?.dataset.id;
    const plan = state.plans.find((item) => String(item.id) === String(id));
    if (plan && window.confirm('确定删除“' + plan.name + '”吗？')) {
      const remove = () => { state.plans = state.plans.filter((item) => String(item.id) !== String(id)); renderPlans(); showToast('定投计划已删除'); };
      if (window.orbitApi?.ready) window.orbitApi.request('/plans/' + encodeURIComponent(id), { method: 'DELETE' }).then(remove).catch((error) => showToast('删除失败：' + error.message));
      else remove();
    }
    return;
  }
  const runButton = event.target.closest('.run-now');
  if (runButton) {
    const card = runButton.closest('[data-id]');
    const id = card?.dataset.id;
    const plan = state.plans.find((item) => String(item.id) === String(id));
    if (!plan) { showToast('计划数据未加载，请刷新页面'); return; }
    if (pendingRuns.has(id)) return;
    if (plan.enabled === false) { showToast('请先恢复计划'); return; }
    if (!window.orbitApi?.ready) { showToast('后端尚未连接'); return; }
    if (document.body.dataset.tradingMode === 'live' && !window.confirm('当前是实盘模式，确认立即投入 ' + plan.amount + ' USDT 吗？')) return;
    pendingRuns.add(id);
    runResults.set(id, { type: 'pending', message: '正在向 Bitget 提交订单，请等待结果。' });
    renderRunResults();
    window.orbitApi.request('/plans/' + encodeURIComponent(id) + '/run', { method: 'POST' }).then((response) => {
      const execution = response.data;
      if (execution.skipped) throw new Error(execution.reason || '该计划已处理过本次执行');
      if (execution.status !== 'submitted' || !execution.orderId) throw new Error('未返回有效的订单编号，请检查执行记录和 Bitget 订单');
      state.executions.unshift({
        createdAt: execution.createdAt || new Date().toISOString(),
        planId: plan.id,
        time: new Date(execution.createdAt || Date.now()).toLocaleString('zh-CN'),
        plan: plan.name,
        pair: displayPair(plan.pair),
        amount: Number(plan.amount).toFixed(2) + ' USDT',
        qty: execution.qty || '—', filledQuoteAmount: execution.filledQuoteAmount || 0, orderId: execution.orderId || '', price: execution.status === 'simulated' ? '模拟价格' : '已提交', status: execution.status
      });
      plan.nextRunAt = execution.nextRunAt || null;
      plan.next = plan.nextRunAt ? formatNextRun(new Date(plan.nextRunAt)) : '待安排';
      renderPlans();
      renderExecutions();
      runResults.set(id, { type: 'success', message: '订单已提交，订单号：' + execution.orderId });
      showToast('实盘订单已提交');
    }).catch((error) => {
      const message = (error.uncertain ? '下单结果待确认：' : '立即投入失败：') + error.message;
      runResults.set(id, { type: 'error', message });
      showToast(message);
    }).finally(() => {
      pendingRuns.delete(id);
      renderRunResults();
    });
    return;
  }
  const toggle = event.target.closest('.toggle');
  if (toggle) {
    const card = toggle.closest('[data-id]');
    if (!card) return;
    toggle.classList.toggle('on');
    const enabled = toggle.classList.contains('on');
    const plan = state.plans.find((item) => String(item.id) === String(card?.dataset.id));
    if (plan) plan.enabled = enabled;
    if (window.orbitApi?.ready && card?.dataset.id) window.orbitApi.request('/plans/' + encodeURIComponent(card.dataset.id), { method: 'PATCH', body: JSON.stringify({ enabled }) }).catch((error) => console.warn('plan status save failed', error.message));
    renderPlans();
    showToast(enabled ? '计划已恢复运行' : '计划已暂停');
  }
  if (event.target.closest('#export-executions')) {
    exportExecutionsCsv();
    return;
  }
  if (event.target.closest('#save-settings')) {
    saveSettings().then(() => showToast('设置已保存')).catch((error) => showToast('设置保存失败：' + error.message));
  }
  if (event.target.closest('#test-telegram')) {
    if (!window.orbitApi?.ready) { showToast('后端尚未连接'); return; }
    const button = event.target.closest('#test-telegram');
    button.disabled = true;
    window.orbitApi.request('/settings/notifications/test', { method: 'POST' })
      .then(() => showToast('Telegram 测试通知已发送'))
      .catch((error) => showToast('测试通知失败：' + error.message))
      .finally(() => { button.disabled = false; });
  }
});

$('#plan-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const pair = data.get('pair');
  const coin = coinFor(pair);
  let plan;
  if (editingPlanId) {
    const current = state.plans.find((item) => String(item.id) === String(editingPlanId));
    const payload = { name: data.get('name'), amount: Number(data.get('amount')), frequency: data.get('frequency'), time: data.get('time') };
    try {
      const saved = window.orbitApi?.ready
        ? (await window.orbitApi.request('/plans/' + encodeURIComponent(editingPlanId), { method: 'PATCH', body: JSON.stringify(payload) })).data
        : { ...current, ...payload, nextRunAt: current.nextRunAt };
      plan = { ...current, ...saved, pair: saved.symbol || current.pair, amount: Number(saved.amount), frequency: `${saved.frequency} · ${saved.time}`, time: saved.time, next: saved.nextRunAt ? formatNextRun(new Date(saved.nextRunAt)) : '待安排', ...coinFor(saved.symbol || current.pair), direction: '买入' };
      state.plans = state.plans.map((item) => String(item.id) === String(editingPlanId) ? plan : item);
      renderPlans();
      closeModal();
      showToast('定投计划已更新');
    } catch (error) {
      showToast('保存失败：' + error.message);
    }
    return;
  }
  if (window.orbitApi?.ready) {
    try {
      const response = await window.orbitApi.request('/plans', { method: 'POST', body: JSON.stringify({ name: data.get('name'), symbol: pair, pair, amount: Number(data.get('amount')), frequency: data.get('frequency'), time: data.get('time'), direction: data.get('direction') }) });
      const saved = response.data;
      plan = { ...saved, pair: saved.symbol || pair, amount: Number(saved.amount), frequency: `${saved.frequency} · ${saved.time}`, next: saved.nextRunAt ? formatNextRun(new Date(saved.nextRunAt)) : '待安排', ...coinFor(saved.symbol || pair), direction: '买入' };
    } catch (error) {
      showToast('创建失败：' + error.message);
      return;
    }
  } else {
    plan = { id: Date.now(), name: data.get('name'), pair, amount: Number(data.get('amount')), frequency: `${data.get('frequency')} · ${data.get('time')}`, next: '待安排', ...coin, direction: data.get('direction') === 'buy' ? '买入' : '卖出', time: data.get('time') };
  }
  state.plans.unshift(plan);
  renderPlans();
  closeModal();
  event.currentTarget.reset();
  showToast('定投计划已创建');
  switchView('plans');
});

$('#plan-search').addEventListener('input', (event) => {
  applyPlanSearch();
});

$('#api-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!window.orbitApi?.ready) { showToast('后端尚未连接'); return; }
  const data = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const response = await window.orbitApi.request('/settings/bitget', {
      method: 'POST',
      body: JSON.stringify({
        apiKey: data.get('apiKey'),
        secretKey: data.get('secretKey'),
        passphrase: data.get('passphrase')
      })
    });
    window.orbitApi.renderApiStatus?.(response.data);
    closeApiModal();
    showToast('Bitget API 密钥已保存');
  } catch (error) {
    showToast('保存密钥失败：' + error.message);
  } finally {
    if (button) button.disabled = false;
  }
});

renderPlans();
renderExecutions();
loadSettings();

window.orbitUi = { renderPlans, renderExecutions, coinFor, displayPair, state };


renderTodayLabel();
setInterval(renderTodayLabel, 30000);
