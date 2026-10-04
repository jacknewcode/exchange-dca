(() => {
  const canUseApi = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  const base = '/api';

  async function request(path, options = {}) {
    if (!canUseApi) throw new Error('请通过 npm start 访问后端');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), path.endsWith('/run') ? 65000 : 8000);
    try {
      const response = await fetch(base + path, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
        signal: options.signal || controller.signal
      });
      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        const error = new Error(payload.error || '请求失败');
        error.uncertain = Boolean(payload.uncertain);
        error.planPaused = Boolean(payload.planPaused);
        error.planFailureCount = payload.planFailureCount;
        throw error;
      }
      return payload;
    } catch (error) {
      if (path.endsWith('/run') && (error.name === 'AbortError' || error instanceof TypeError)) {
        const pending = new Error('未收到下单结果，请先检查执行记录和 Bitget 订单，再决定是否重试');
        pending.uncertain = true;
        throw pending;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  window.orbitApi = { request, ready: false };

  function setSync(text, connected) {
    const node = document.querySelector('.sync-status');
    if (!node) return;
    node.innerHTML = '<i></i>' + text;
    node.classList.toggle('connected', Boolean(connected));
  }

  function renderMode(mode) {
    const title = document.querySelector('#mode-title');
    const description = document.querySelector('#mode-description');
    if (title) title.textContent = '实盘交易模式';
    if (description) description.textContent = '会向 Bitget 提交真实订单';
    const sidebarLabel = document.querySelector('#sidebar-mode-label');
    const sidebarStatus = document.querySelector('#sidebar-mode-status');
    if (sidebarLabel) sidebarLabel.textContent = '实盘交易模式';
    if (sidebarStatus) sidebarStatus.textContent = '已启用';
    const accountTitle = document.querySelector('#account-mode-title');
    const accountDescription = document.querySelector('#account-mode-description');
    if (accountTitle) accountTitle.textContent = '实盘交易模式已开启';
    if (accountDescription) accountDescription.textContent = '立即投入和定时任务会向 Bitget 提交真实订单，请确认 API 权限和交易额度。';
  }

  function renderApiStatus(data = {}) {
    const mask = document.querySelector('#api-key-mask');
    const permission = document.querySelector('#api-permission');
    if (mask) mask.textContent = data.configured ? (data.apiKey || '已配置') : '尚未配置';
    if (permission) permission.textContent = data.configured ? '读取 + 交易' : '未连接';
    const settingsStatus = document.querySelector('#settings-api-status');
    if (settingsStatus) settingsStatus.textContent = data.configured ? '读取 + 交易' : '未配置';
  }

  function renderNotificationStatus(data = {}) {
    const node = document.querySelector('#telegram-status');
    const enabled = document.querySelector('#telegram-enabled');
    const failures = document.querySelector('#telegram-notify-failures');
    if (enabled && data.enabled !== undefined) enabled.checked = Boolean(data.enabled);
    if (failures && data.notifyFailures !== undefined) failures.checked = Boolean(data.notifyFailures);
    if (node) node.textContent = data.configured ? (data.enabled ? 'Telegram 通知已启用 · Chat ID ' + (data.chatId || '') : '已配置但未启用') : '尚未配置';
  }

  let marketSearchTimer;
  let marketRequestSerial = 0;
  async function loadMarkets(query = '') {
    const serial = ++marketRequestSerial;
    const status = document.querySelector('#market-status');
    const select = document.querySelector('#market-select');
    if (!select) return;
    try {
      const markets = await request('/markets?quoteCoin=USDT&limit=80' + (query ? '&search=' + encodeURIComponent(query) : ''));
      if (serial !== marketRequestSerial) return;
      const list = Array.isArray(markets.data) ? markets.data : [];
      select.innerHTML = list.length
        ? list.map((item) => '<option value="' + item.symbol + '">' + item.baseCoin + ' / ' + item.quoteCoin + '</option>').join('')
        : '<option value="" disabled>没有匹配的 USDT 交易对</option>';
      if (status) {
        if (markets.stale) status.textContent = 'Bitget 暂时无法连接，已加载本地交易对缓存；稍后刷新可更新完整列表';
        else status.textContent = '显示 ' + list.length + ' 个结果，共匹配 ' + Number(markets.total || list.length) + ' 个交易对';
      }
      if (list.length) select.value = list[0].symbol;
    } catch (error) {
      if (status) status.textContent = '交易对接口暂时不可用：' + error.message;
      console.warn('markets sync failed', error.message);
    }
  }

  function formatBalance(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 }) + ' USDT' : '— USDT';
  }

  function renderAssets(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const usdt = list.find((item) => String(item.coin || '').toUpperCase() === 'USDT');
    if (!usdt) return false;
    const available = Number(usdt.available ?? usdt.availableBalance ?? usdt.availableAmount);
    const total = Number(usdt.balance ?? usdt.equity ?? usdt.totalBalance ?? usdt.available ?? usdt.availableBalance);
    const frozen = Number(usdt.frozen ?? usdt.frozenBalance ?? usdt.locked ?? (Number.isFinite(total) && Number.isFinite(available) ? total - available : NaN));
    const totalNode = document.querySelector('.balance-total');
    const availableNode = document.querySelector('#available-balance');
    const frozenNode = document.querySelector('#frozen-balance');
    if (totalNode) totalNode.innerHTML = formatBalance(total).replace(' USDT', ' <small>USDT</small>');
    if (availableNode) availableNode.textContent = formatBalance(available);
    if (frozenNode) frozenNode.textContent = formatBalance(frozen);
    const synced = document.querySelector('#balance-sync-time');
    if (synced) synced.textContent = '最后同步：' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const assetList = document.querySelector('#asset-list');
    const assetCount = document.querySelector('#asset-count');
    const nonZero = list.filter((item) => {
      const totalValue = Number(item.balance ?? item.equity ?? item.totalBalance ?? item.available ?? item.availableBalance ?? 0);
      return Number.isFinite(totalValue) && totalValue !== 0;
    }).sort((a, b) => String(a.coin || '').localeCompare(String(b.coin || '')));
    if (assetCount) assetCount.textContent = nonZero.length + ' 种';
    if (assetList) {
      assetList.innerHTML = nonZero.length ? nonZero.map((item) => {
        const availableValue = Number(item.available ?? item.availableBalance ?? item.availableAmount ?? 0);
        const totalValue = Number(item.balance ?? item.equity ?? item.totalBalance ?? item.available ?? item.availableBalance ?? 0);
        const frozenValue = Number(item.frozen ?? item.frozenBalance ?? item.locked ?? (totalValue - availableValue));
        const coin = String(item.coin || '').toUpperCase();
        const decimals = coin === 'USDT' ? 2 : 8;
        const format = (value) => Number.isFinite(value) ? value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals }) : '—';
        return '<div class="asset-row"><strong>' + coin + '</strong><span>' + format(availableValue) + '</span><span>' + format(frozenValue) + '</span><span>' + format(totalValue) + '</span></div>';
      }).join('') : '<div class="empty-state"><strong>暂无持仓</strong><span>Bitget 当前没有返回非零资产。</span></div>';
    }
    return true;
  }

  async function syncAssets(showFeedback = false) {
    const button = document.querySelector('#sync-balance');
    if (button?.dataset.syncing === 'true') return;
    if (button) {
      button.dataset.syncing = 'true';
      button.classList.add('syncing');
      button.setAttribute('aria-busy', 'true');
    }
    try {
      const assets = await request('/account/assets');
      if (!renderAssets(assets.data)) throw new Error('Bitget 未返回 USDT 余额');
      if (showFeedback) showModeToast('余额已同步');
      return assets.data;
    } catch (error) {
      if (showFeedback) showModeToast('余额同步失败：' + error.message);
      throw error;
    } finally {
      if (button) {
        button.dataset.syncing = 'false';
        button.classList.remove('syncing');
        button.removeAttribute('aria-busy');
      }
    }
  }

  async function syncBackend() {
    if (!canUseApi) {
      setSync('本地文件模式', false);
      return;
    }
    try {
      const health = await request('/health');
      window.orbitApi.ready = true;
      setSync('实盘交易已连接', true);
      document.body.dataset.tradingMode = health.mode;
      renderMode(health.mode);
      loadMarkets();
      const results = await Promise.allSettled([
        request('/settings/bitget'),
        request('/settings/notifications'),
        request('/plans'),
        request('/executions')
      ]);
      const [credentialsResult, notificationsResult, plansResult, executionsResult] = results;
      if (credentialsResult.status === 'fulfilled') renderApiStatus(credentialsResult.value.data);
      else console.warn('API credential status skipped', credentialsResult.reason?.message || credentialsResult.reason);
      if (notificationsResult.status === 'fulfilled') renderNotificationStatus(notificationsResult.value.data);
      else console.warn('notification settings skipped', notificationsResult.reason?.message || notificationsResult.reason);
      if (plansResult.status === 'fulfilled' && window.orbitUi && Array.isArray(plansResult.value.data)) {
        window.orbitUi.state.plans = plansResult.value.data.map((plan) => ({
          ...plan,
          pair: plan.symbol || plan.pair,
          amount: Number(plan.amount),
          frequency: plan.frequency + ' · ' + plan.time,
          next: plan.nextRunAt ? new Date(plan.nextRunAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '待安排',
          ...window.orbitUi.coinFor(plan.symbol || plan.pair),
          direction: '买入'
        }));
        window.orbitUi.renderPlans();
      } else if (plansResult.status === 'rejected') console.warn('plans sync failed', plansResult.reason?.message || plansResult.reason);
      if (executionsResult.status === 'fulfilled' && window.orbitUi && Array.isArray(executionsResult.value.data)) {
        window.orbitUi.state.executions = executionsResult.value.data.map((item) => ({
          id: item.id,
          createdAt: item.createdAt,
          planId: item.planId,
          time: new Date(item.createdAt).toLocaleString('zh-CN'),
          plan: item.planName,
          pair: item.symbol,
          amount: Number(item.amount).toFixed(2) + ' USDT',
          qty: item.qty || item.baseQuantity || '—',
          filledQuoteAmount: item.filledQuoteAmount || item.quoteAmount || 0,
          orderId: item.orderId || '',
          price: item.status === 'simulated' ? '模拟价格' : '已提交',
          status: item.status
        }));
        window.orbitUi.renderExecutions();
      } else if (executionsResult.status === 'rejected') console.warn('executions sync failed', executionsResult.reason?.message || executionsResult.reason);

      const syncTime = document.querySelector('#balance-sync-time');
      if (syncTime) syncTime.textContent = '点击“立即同步”读取账户资产';
    } catch (error) {
      setSync('后端未连接', false);
      const status = document.querySelector('#market-status');
      if (status) status.textContent = '后端未连接，已显示常用交易对；请检查服务后刷新';
      console.warn('backend unavailable', error.message);
    }
  }

  window.orbitApi.renderApiStatus = renderApiStatus;
  window.orbitApi.renderNotificationStatus = renderNotificationStatus;
  window.orbitApi.syncAssets = syncAssets;
  syncBackend();

  document.addEventListener('input', (event) => {
    if (event.target?.id !== 'market-search') return;
    const query = event.target.value.trim().toLowerCase();
    clearTimeout(marketSearchTimer);
    marketSearchTimer = setTimeout(() => loadMarkets(query), 250);
  });

  document.addEventListener('change', (event) => {
    if (event.target?.id === 'market-select') {
      const search = document.querySelector('#market-search');
      if (search) search.value = event.target.selectedOptions[0]?.textContent || '';
    }
  });

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-view="account"]') && window.orbitApi.ready) {
      syncAssets().catch((error) => console.warn('asset sync skipped', error.message));
    }
    if (event.target.closest('#sync-balance')) {
      if (!window.orbitApi.ready) { showModeToast('后端尚未连接'); return; }
      syncAssets(true).catch(() => {});
    }
  });

  function showModeToast(message) {
    const node = document.querySelector('#toast-message');
    const toast = document.querySelector('#toast');
    if (!node || !toast) return;
    node.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2400);
  }
})();

