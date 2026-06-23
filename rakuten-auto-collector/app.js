(() => {
  const API_BASE_KEY = 'rakuten-auto-collector-api-base-v1';
  const API_TOKEN_KEY = 'rakuten-auto-collector-api-token-v1';
  const $ = (selector) => document.querySelector(selector);
  const rows = $('#monitorRows');
  const empty = $('#emptyState');
  const dialog = $('#monitorDialog');
  const form = $('#monitorForm');
  const apiDialog = $('#apiSettingsDialog');
  const apiForm = $('#apiSettingsForm');
  const localApiDefault = ['localhost', '127.0.0.1', '::1'].includes(location.hostname)
    ? location.origin
    : '';
  let apiBase = localStorage.getItem(API_BASE_KEY) || localApiDefault;
  let apiToken = localStorage.getItem(API_TOKEN_KEY) || '';
  let monitors = [];
  let logs = [];
  let dashboardState = null;
  let apiConnected = false;
  let loading = false;
  let toastTimer;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
  }

  function formatTime(value) {
    if (!value) return '未取得';
    return new Intl.DateTimeFormat('ja-JP', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).format(new Date(value));
  }

  function sparkline(values) {
    const ranks = (values || [])
      .filter((entry) => Number.isFinite(entry?.rank))
      .slice(0, 20)
      .reverse()
      .map((entry) => entry.rank);
    if (ranks.length < 2) {
      return '<span class="muted">データ待ち</span>';
    }
    const width = 130, height = 38, pad = 3;
    const min = Math.min(...ranks), max = Math.max(...ranks);
    const range = Math.max(max - min, 1);
    const points = ranks.map((v, i) => {
      const x = pad + i * ((width - pad * 2) / (ranks.length - 1));
      const y = pad + ((v - min) / range) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" aria-label="順位推移"><polyline points="${points}" fill="none" stroke="#bf0000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function statusInfo(monitor) {
    if (!monitor.enabled) return { className: 'off', label: '停止中' };
    if (monitor.status === 'ok') return { className: 'on', label: '取得済み' };
    if (monitor.status === 'not_found') return { className: 'wait', label: '圏外' };
    if (monitor.status === 'error') return { className: 'wait', label: 'エラー' };
    return { className: 'wait', label: '取得待ち' };
  }

  function rankHtml(monitor) {
    if (!Number.isFinite(monitor.currentRank)) return '<span class="muted">未取得</span>';
    const delta = Number.isFinite(monitor.delta) && monitor.delta !== 0
      ? `<span class="${monitor.delta > 0 ? 'rank-up' : 'rank-down'}">${monitor.delta > 0 ? '▲' : '▼'}${Math.abs(monitor.delta)}</span>`
      : '';
    return `<span class="rank">${monitor.currentRank}位</span>${delta}`;
  }

  function shopRankedHtml(monitor) {
    if (!Number.isFinite(monitor.shopRankedCount)) return '<span class="muted">未取得</span>';
    const details = (monitor.rankedItems || [])
      .slice(0, 8)
      .map((entry) => `${entry.rank}位 ${entry.item?.itemName || entry.item?.itemCode || ''}`)
      .join('\n');
    const title = details || '指定店舗の商品は見つかりませんでした';
    return `<span class="rank-count" title="${escapeHtml(title)}">${monitor.shopRankedCount}件</span>`;
  }

  function render() {
    const query = $('#searchInput').value.trim().toLowerCase();
    const filtered = monitors.filter((monitor) =>
      `${monitor.keyword} ${monitor.shopCode} ${monitor.itemCode || ''}`.toLowerCase().includes(query)
    );
    rows.innerHTML = filtered.map((monitor) => {
      const status = statusInfo(monitor);
      const disabled = apiConnected ? '' : 'disabled';
      return `
        <tr>
          <td><label class="switch" title="${apiConnected ? '監視の有効・無効' : '変更にはAPI接続が必要です'}"><input type="checkbox" data-action="toggle" data-id="${escapeHtml(monitor.id)}" ${monitor.enabled ? 'checked' : ''} ${disabled}><span class="slider"></span></label></td>
          <td><div class="monitor-title">${escapeHtml(monitor.keyword)}</div><div class="monitor-meta">${monitor.itemCode ? '商品: ' + escapeHtml(monitor.itemCode) : '商品指定なし'}</div></td>
          <td><span class="shop-code">${escapeHtml(monitor.shopCode)}</span></td>
          <td>${rankHtml(monitor)}</td>
          <td>${shopRankedHtml(monitor)}</td>
          <td>${sparkline(monitor.history)}</td>
          <td class="muted">${formatTime(monitor.lastFetchedAt)}</td>
          <td><span class="state ${status.className}" title="${escapeHtml(monitor.error || '')}">${status.label}</span></td>
          <td><div class="row-actions"><button class="danger" type="button" data-action="delete" data-id="${escapeHtml(monitor.id)}" ${disabled}>削除</button></div></td>
        </tr>`;
    }).join('');
    empty.innerHTML = apiConnected
      ? '<strong>該当する監視条件がありません</strong>右上のボタンからキーワードを登録できます。'
      : '<strong>監視条件がまだ登録されていません</strong>APIサーバーへ接続するか、GitHubのconfig/monitors.jsonへ登録してください。';
    empty.style.display = filtered.length ? 'none' : 'block';
    $('table').style.display = filtered.length ? 'table' : 'none';
    $('#monitorCount').textContent = monitors.length;
    $('#enabledCount').textContent = monitors.filter((m) => m.enabled).length;
    $('#listCount').textContent = `${filtered.length}件`;
    const fetched = dashboardState?.generatedAt
      || monitors.map((monitor) => monitor.lastFetchedAt).filter(Boolean).sort().at(-1);
    $('#lastFetch').textContent = fetched ? formatTime(fetched) : '未取得';
    renderLogs();
  }

  function renderLogs() {
    const target = $('#logList');
    if (!logs.length) {
      target.innerHTML = '<div class="muted">ログはありません。</div>';
      return;
    }
    target.innerHTML = logs.slice(0, 6).map((log) => `
      <div class="log">
        <span class="log-time">${formatTime(log.time)}</span>
        <span>${escapeHtml(log.message)}</span>
        <span class="log-level">${escapeHtml({
          success: '成功', warning: '注意', error: 'エラー', info: '情報'
        }[log.level] || log.level)}</span>
      </div>`).join('');
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  function closeDialog() {
    dialog.close();
    form.reset();
  }

  function openApiSettings() {
    $('#apiBaseInput').value = apiBase;
    $('#apiTokenInput').value = apiToken;
    apiDialog.showModal();
    setTimeout(() => $('#apiBaseInput').focus(), 0);
  }

  function closeApiSettings() {
    apiDialog.close();
  }

  function setConnectionUi(mode, detail = '') {
    const notice = $('#connectionNotice');
    notice.className = 'notice';
    $('#connectionBadge').className = 'notice-badge';
    if (mode === 'api') {
      notice.classList.add('connected');
      $('#connectionBadge').classList.add('connected');
      $('#connectionTitle').textContent = '収集APIサーバーに接続済み';
      $('#connectionText').textContent = '監視条件の変更、手動収集、サーバー側の履歴保存を利用できます。';
      $('#connectionBadge').textContent = 'API 接続済み';
      $('#systemStatus').textContent = '稼働中';
      $('#systemNote').textContent = 'サーバーAPIから最新データを表示';
      $('#systemDot').style.background = '#178647';
      return;
    }
    if (mode === 'static') {
      $('#connectionTitle').textContent = 'GitHub Actionsの収集データを表示';
      $('#connectionText').textContent = '定期収集結果は閲覧できます。監視条件の変更と手動収集にはAPIサーバー接続が必要です。';
      $('#connectionBadge').textContent = '公開JSON';
      $('#systemStatus').textContent = '閲覧モード';
      $('#systemNote').textContent = 'GitHubへ保存されたデータを表示';
      $('#systemDot').style.background = '#d88a13';
      return;
    }
    notice.classList.add('error');
    $('#connectionTitle').textContent = '収集データを読み込めません';
    $('#connectionText').textContent = detail || 'API設定または公開データを確認してください。';
    $('#connectionBadge').textContent = '接続エラー';
    $('#systemStatus').textContent = 'エラー';
    $('#systemNote').textContent = 'API設定を確認してください';
    $('#systemDot').style.background = '#bf0000';
  }

  function requestHeaders(withBody = false) {
    const headers = {};
    if (withBody) headers['content-type'] = 'application/json';
    if (apiToken) headers.authorization = `Bearer ${apiToken}`;
    return headers;
  }

  async function apiRequest(path, options = {}) {
    if (!apiBase) throw new Error('APIサーバーが設定されていません');
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        ...requestHeaders(Boolean(options.body)),
        ...(options.headers || {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `API ${response.status}`);
    return body;
  }

  async function loadDashboard({ quiet = false } = {}) {
    if (loading) return;
    loading = true;
    if (!quiet) showToast('収集データを読み込んでいます');
    let state;
    let apiError;
    apiConnected = false;

    try {
      if (apiBase) {
        try {
          state = await apiRequest('/api/state');
          apiConnected = true;
        } catch (error) {
          apiError = error;
        }
      }
      if (!state) {
        const response = await fetch(`./data/state.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`公開データ ${response.status}`);
        state = await response.json();
      }
      dashboardState = state;
      monitors = Array.isArray(state.monitors) ? state.monitors : [];
      logs = Array.isArray(state.logs) ? state.logs : [];
      setConnectionUi(apiConnected ? 'api' : 'static');
      render();
      if (apiError && !quiet) showToast(`API未接続: ${apiError.message}`);
    } catch (error) {
      dashboardState = null;
      monitors = [];
      logs = [];
      setConnectionUi('error', error.message);
      render();
      if (!quiet) showToast(error.message);
    } finally {
      loading = false;
    }
  }

  $('#addButton').addEventListener('click', () => {
    if (!apiConnected) {
      openApiSettings();
      showToast('監視条件の変更にはAPI接続が必要です');
      return;
    }
    dialog.showModal();
    setTimeout(() => $('#keywordInput').focus(), 0);
  });
  $('#closeDialog').addEventListener('click', closeDialog);
  $('#cancelDialog').addEventListener('click', closeDialog);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog();
  });
  $('#searchInput').addEventListener('input', render);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      await apiRequest('/api/monitors', {
        method: 'POST',
        body: JSON.stringify({
          keyword: data.get('keyword').trim(),
          shopCode: data.get('shop').trim(),
          itemCode: data.get('item').trim(),
          enabled: true,
          maxPages: 4,
          sort: 'standard'
        })
      });
      closeDialog();
      await loadDashboard({ quiet: true });
      showToast('監視条件をサーバーへ登録しました');
    } catch (error) {
      showToast(error.message);
    }
  });

  rows.addEventListener('change', async (event) => {
    const input = event.target.closest('[data-action="toggle"]');
    if (!input) return;
    try {
      await apiRequest(`/api/monitors/${encodeURIComponent(input.dataset.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: input.checked })
      });
      await loadDashboard({ quiet: true });
      showToast(`監視を${input.checked ? '有効' : '停止'}にしました`);
    } catch (error) {
      await loadDashboard({ quiet: true });
      showToast(error.message);
    }
  });

  rows.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action="delete"]');
    if (!button) return;
    const monitor = monitors.find((item) => item.id === button.dataset.id);
    if (!monitor || !confirm(`「${monitor.keyword}」を削除しますか？`)) return;
    try {
      await apiRequest(`/api/monitors/${encodeURIComponent(button.dataset.id)}`, {
        method: 'DELETE'
      });
      await loadDashboard({ quiet: true });
      showToast('監視条件を削除しました');
    } catch (error) {
      showToast(error.message);
    }
  });

  $('#refreshButton').addEventListener('click', () => loadDashboard());

  $('#runButton').addEventListener('click', async () => {
    if (!apiConnected) {
      openApiSettings();
      showToast('手動収集にはAPI接続が必要です');
      return;
    }
    const button = $('#runButton');
    button.disabled = true;
    button.textContent = '収集中...';
    try {
      const state = await apiRequest('/api/collect', { method: 'POST' });
      dashboardState = state;
      monitors = state.monitors || [];
      logs = state.logs || [];
      render();
      showToast('楽天市場の順位を収集しました');
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = '今すぐ収集';
    }
  });

  $('#apiSettingsButton').addEventListener('click', openApiSettings);
  $('#closeApiSettings').addEventListener('click', closeApiSettings);
  $('#cancelApiSettings').addEventListener('click', closeApiSettings);
  apiDialog.addEventListener('click', (event) => {
    if (event.target === apiDialog) closeApiSettings();
  });

  apiForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(apiForm);
    const enteredBase = String(data.get('apiBase') || '').trim().replace(/\/+$/, '');
    if (enteredBase) {
      try {
        new URL(enteredBase);
      } catch (_) {
        showToast('APIサーバーURLが正しくありません');
        return;
      }
    }
    apiBase = enteredBase;
    apiToken = String(data.get('apiToken') || '');
    apiBase
      ? localStorage.setItem(API_BASE_KEY, apiBase)
      : localStorage.removeItem(API_BASE_KEY);
    apiToken
      ? localStorage.setItem(API_TOKEN_KEY, apiToken)
      : localStorage.removeItem(API_TOKEN_KEY);
    closeApiSettings();
    await loadDashboard();
  });

  $('#clearApiSettings').addEventListener('click', async () => {
    apiBase = '';
    apiToken = '';
    localStorage.removeItem(API_BASE_KEY);
    localStorage.removeItem(API_TOKEN_KEY);
    apiForm.reset();
    closeApiSettings();
    await loadDashboard();
  });

  loadDashboard({ quiet: true });
})();
