/* app.js - Copilot Cowork Credit Chargeback (100% client-side).
   Parsing, join, computation, rendering, slicers, what-if, and exports.
   No frameworks, no network calls. */
(function () {
    'use strict';

    // ------------------------------------------------------------------ state
    var state = {
        pending: { entra: null, credits: null },
        entraRows: [],
        creditRows: [],
        users: [],
        dims: [],
        sliceBy: 'Department',
        rate: 0.01,
        fallbackLimit: 400,
        usedFallbackLimit: false,
        demoActive: false,
        activeTab: 'exec',
        cohortFilter: {}, // cohort name -> boolean (enabled)
        computed: null
    };

    var COHORT_ORDER = ['Light', 'Regular', 'Engaged', 'Native', 'Power', 'Frontier'];

    var DIMS = [
        { key: 'Department', field: 'department' },
        { key: 'Business Unit', field: 'businessUnit' },
        { key: 'Job Family', field: 'jobFamily' },
        { key: 'Job Title', field: 'jobTitle' },
        { key: 'Cost Center', field: 'costCenter' },
        { key: 'Country', field: 'country' },
        { key: 'Manager', field: 'manager' }
    ];

    var TABS = [
        { id: 'exec', label: 'Executive Overview' },
        { id: 'group', label: 'Group Chargeback' },
        { id: 'cc', label: 'Cost Center & BU' },
        { id: 'opt', label: 'Optimization' },
        { id: 'standout', label: 'Standout Individuals' },
        { id: 'cohorts', label: 'Usage Cohorts' },
        { id: 'users', label: 'User Detail' },
        { id: 'focus', label: 'FOCUS Cost View' },
        { id: 'glossary', label: 'Glossary / Notes' }
    ];

    var COLUMN_CANDIDATES = {
        upn: ['user principal name', 'userprincipalname', 'upn', 'email', 'user'],
        displayName: ['display name', 'displayname', 'name'],
        department: ['department', 'dept'],
        jobTitle: ['job title', 'jobtitle', 'title'],
        jobFamily: ['job family', 'jobfamily'],
        costCenter: ['cost center', 'costcenter', 'cc'],
        businessUnit: ['business unit', 'businessunit', 'bu'],
        country: ['country', 'usagelocation', 'usage location'],
        manager: ['manager', 'manager upn', 'manager email'],
        creditsUsed: ['monthly credits used', 'credits used', 'creditsused', 'cowork credits', 'credits'],
        creditLimit: ['monthly credit limit', 'credit limit', 'creditlimit', 'limit', 'allowance'],
        license: ['microsoft 365 copilot license', 'copilot license', 'license', 'licensed'],
        lastActivity: ['last activity date', 'last activity', 'lastactivitydate'],
        sessions: ['session count', 'sessions', 'sessioncount']
    };

    // --------------------------------------------------------------- utilities
    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }

    function fmtInt(v) { return (Math.round(v) || 0).toLocaleString('en-US'); }
    function fmtMoney(v) {
        return '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function fmtPct(v) { return ((Number(v) || 0) * 100).toFixed(1) + '%'; }
    function fmtNum2(v) { return (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }

    function normUpn(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

    function toNumber(s) {
        if (s == null) return 0;
        var n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
        return isFinite(n) ? n : 0;
    }

    function toBool(s) {
        var v = String(s == null ? '' : s).trim().toLowerCase();
        return v === 'yes' || v === 'true' || v === '1' || v === 'licensed' || v === 'y';
    }

    // ------------------------------------------------------------ CSV parsing
    function parseCSV(text) {
        var rows = [];
        var field = '';
        var record = [];
        var inQuotes = false;
        text = String(text).replace(/^\uFEFF/, ''); // strip BOM
        for (var i = 0; i < text.length; i++) {
            var c = text[i];
            if (inQuotes) {
                if (c === '"') {
                    if (text[i + 1] === '"') { field += '"'; i++; }
                    else { inQuotes = false; }
                } else { field += c; }
            } else {
                if (c === '"') { inQuotes = true; }
                else if (c === ',') { record.push(field); field = ''; }
                else if (c === '\r') { /* ignore, handled by \n */ }
                else if (c === '\n') { record.push(field); rows.push(record); record = []; field = ''; }
                else { field += c; }
            }
        }
        if (field.length > 0 || record.length > 0) { record.push(field); rows.push(record); }
        // Drop fully-empty trailing rows.
        rows = rows.filter(function (r) { return r.length > 1 || (r.length === 1 && r[0].trim() !== ''); });
        if (rows.length === 0) return [];
        var headers = rows[0].map(function (h) { return String(h).trim(); });
        var out = [];
        for (var r = 1; r < rows.length; r++) {
            var obj = {};
            for (var h = 0; h < headers.length; h++) { obj[headers[h]] = rows[r][h] != null ? rows[r][h] : ''; }
            out.push(obj);
        }
        return out;
    }

    // Resolve which actual header maps to a logical field.
    function resolveColumns(headers) {
        var lower = {};
        headers.forEach(function (h) { lower[String(h).trim().toLowerCase()] = h; });
        var map = {};
        Object.keys(COLUMN_CANDIDATES).forEach(function (field) {
            var cands = COLUMN_CANDIDATES[field];
            for (var i = 0; i < cands.length; i++) {
                if (lower[cands[i]] != null) { map[field] = lower[cands[i]]; return; }
            }
            map[field] = null;
        });
        return map;
    }

    // --------------------------------------------------------- build + join
    function buildUsers(entraRows, creditRows) {
        var entraMap = resolveColumns(entraRows.length ? Object.keys(entraRows[0]) : []);
        var creditMap = resolveColumns(creditRows.length ? Object.keys(creditRows[0]) : []);

        // Index entra by normalized UPN.
        var byUpn = {};
        entraRows.forEach(function (row) {
            var upn = normUpn(entraMap.upn ? row[entraMap.upn] : '');
            if (!upn) return;
            byUpn[upn] = row;
        });

        state.usedFallbackLimit = !creditMap.creditLimit;

        var users = [];
        creditRows.forEach(function (crow) {
            var upn = normUpn(creditMap.upn ? crow[creditMap.upn] : '');
            if (!upn) return;
            var erow = byUpn[upn] || {};
            var get = function (map, row, field) { return map[field] ? String(row[map[field]] || '').trim() : ''; };

            var limit = creditMap.creditLimit ? toNumber(crow[creditMap.creditLimit]) : state.fallbackLimit;
            if (!creditMap.creditLimit || limit <= 0 && !creditMap.creditLimit) limit = state.fallbackLimit;

            users.push({
                upn: upn,
                displayName: get(creditMap, crow, 'displayName') || get(entraMap, erow, 'displayName') || upn,
                department: get(entraMap, erow, 'department') || 'Unknown',
                jobTitle: get(entraMap, erow, 'jobTitle') || '',
                jobFamily: get(entraMap, erow, 'jobFamily') || '',
                costCenter: get(entraMap, erow, 'costCenter') || '',
                businessUnit: get(entraMap, erow, 'businessUnit') || '',
                country: get(entraMap, erow, 'country') || '',
                manager: get(entraMap, erow, 'manager') || '',
                used: creditMap.creditsUsed ? toNumber(crow[creditMap.creditsUsed]) : 0,
                limit: limit,
                sessions: creditMap.sessions ? toNumber(crow[creditMap.sessions]) : 0,
                licensed: creditMap.license ? toBool(crow[creditMap.license]) : false,
                lastActivity: get(creditMap, crow, 'lastActivity')
            });
        });
        return users;
    }

    function detectDims(users) {
        return DIMS.filter(function (d) {
            return users.some(function (u) { var v = u[d.field]; return v && v !== 'Unknown'; });
        });
    }

    // ------------------------------------------------------------- compute
    function cohortForP(p) {
        if (p <= 0.50) return 'Light';
        if (p <= 0.75) return 'Regular';
        if (p <= 0.90) return 'Engaged';
        if (p <= 0.95) return 'Native';
        if (p <= 0.99) return 'Power';
        return 'Frontier';
    }

    function computePerUser() {
        var users = state.users;
        var rate = state.rate;
        var n = users.length || 1;

        // Cohort by percentile of used across ALL users (rank ascending / count).
        var sorted = users.slice().sort(function (a, b) { return a.used - b.used; });
        sorted.forEach(function (u, i) { u.cohort = cohortForP((i + 1) / n); });

        // Department averages for standout ratio.
        var deptSum = {}, deptCount = {};
        users.forEach(function (u) {
            var d = u.department || 'Unknown';
            deptSum[d] = (deptSum[d] || 0) + u.used;
            deptCount[d] = (deptCount[d] || 0) + 1;
        });

        users.forEach(function (u) {
            var d = u.department || 'Unknown';
            var avg = deptCount[d] ? deptSum[d] / deptCount[d] : 0;
            u.deptAvg = avg;
            u.standout = avg > 0 ? u.used / avg : 0;
            u.star = u.standout >= 2;
            u.overage = Math.max(0, u.used - u.limit);
            u.unused = Math.max(0, u.limit - u.used);
            u.util = u.limit > 0 ? u.used / u.limit : 0;
            u.budgetStatus = u.util > 1 ? 'Over' : (u.util >= 0.85 ? 'Near' : 'Under');
            u.chargeback = u.overage * rate;
        });
    }

    function activeUsers() {
        var f = state.cohortFilter;
        var anyOff = COHORT_ORDER.some(function (c) { return f[c] === false; });
        if (!anyOff) return state.users;
        return state.users.filter(function (u) { return f[u.cohort] !== false; });
    }

    function aggregate(users, field) {
        var groups = {};
        users.forEach(function (u) {
            var key = u[field] && String(u[field]).trim() ? String(u[field]).trim() : 'Unknown';
            var g = groups[key] || (groups[key] = {
                label: key, userCount: 0, totalUsed: 0, totalLimit: 0,
                overageCredits: 0, unusedCredits: 0
            });
            g.userCount += 1;
            g.totalUsed += u.used;
            g.totalLimit += u.limit;
            g.overageCredits += u.overage;
            g.unusedCredits += u.unused;
        });
        var rate = state.rate;
        var arr = Object.keys(groups).map(function (k) {
            var g = groups[k];
            g.utilization = g.totalLimit > 0 ? g.totalUsed / g.totalLimit : 0;
            g.chargeback = g.overageCredits * rate;
            g.chargebackPct = g.totalLimit > 0 ? g.overageCredits / g.totalLimit : 0;
            g.status = g.utilization > 1 ? 'Over' : (g.utilization >= 0.85 ? 'Near' : 'Under');
            return g;
        });
        arr.sort(function (a, b) { return b.chargeback - a.chargeback; });
        return arr;
    }

    function orgTotals(users) {
        var rate = state.rate;
        var t = {
            userCount: users.length, totalUsed: 0, totalLimit: 0, totalOverageCredits: 0,
            totalUnusedCredits: 0, usersOverLimit: 0, usersNearLimit: 0, usersWithinBudget: 0,
            licensedUsers: 0
        };
        users.forEach(function (u) {
            t.totalUsed += u.used;
            t.totalLimit += u.limit;
            t.totalOverageCredits += u.overage;
            t.totalUnusedCredits += u.unused;
            if (u.util > 1) t.usersOverLimit += 1;
            else if (u.util >= 0.85) t.usersNearLimit += 1;
            else t.usersWithinBudget += 1;
            if (u.licensed) t.licensedUsers += 1;
        });
        t.utilization = t.totalLimit > 0 ? t.totalUsed / t.totalLimit : 0;
        t.chargeback = t.totalOverageCredits * rate;
        t.avgCreditsPerUser = t.userCount > 0 ? t.totalUsed / t.userCount : 0;
        return t;
    }

    function focusMapping(totalUsed) {
        var rate = state.rate;
        var listCost = totalUsed * 0.01;
        var contractedCost = totalUsed * rate;
        return {
            listCost: listCost,
            contractedCost: contractedCost,
            effectiveCost: contractedCost,
            billedCost: contractedCost,
            savingsVsList: listCost - contractedCost
        };
    }

    function cohortStats() {
        var users = state.users; // cohorts view uses all users
        var stats = {};
        COHORT_ORDER.forEach(function (c) { stats[c] = { cohort: c, users: 0, totalUsed: 0 }; });
        users.forEach(function (u) {
            var s = stats[u.cohort] || (stats[u.cohort] = { cohort: u.cohort, users: 0, totalUsed: 0 });
            s.users += 1; s.totalUsed += u.used;
        });
        var n = users.length || 1;
        return COHORT_ORDER.map(function (c) {
            var s = stats[c];
            s.pct = s.users / n;
            s.avg = s.users > 0 ? s.totalUsed / s.users : 0;
            return s;
        });
    }

    function compute() {
        computePerUser();
        var au = activeUsers();
        var field = dimField(state.sliceBy);
        state.computed = {
            activeUsers: au,
            groups: aggregate(au, field),
            org: orgTotals(au),
            cohorts: cohortStats(),
            focus: focusMapping(orgTotals(au).totalUsed)
        };
    }

    function dimField(key) {
        var d = DIMS.filter(function (x) { return x.key === key; })[0];
        return d ? d.field : 'department';
    }

    // ------------------------------------------------------------- charts
    function horizontalBarChart(el, data, opts) {
        if (!el) return;
        opts = opts || {};
        var fmt = opts.valueFormat || function (v) { return fmtInt(v); };
        var chartW = 700, rowH = 28, gap = 9, top = 8, labelW = 170, rightPad = 90;
        var barAreaW = chartW - labelW - rightPad;
        var rows = data.length;
        var H = Math.max(60, top + rows * (rowH + gap));
        var max = 1;
        data.forEach(function (d) { if (d.value > max) max = d.value; });
        var bars = '';
        data.forEach(function (d, i) {
            var y = top + i * (rowH + gap);
            var w = Math.max(2, (d.value / max) * barAreaW);
            var color = d.color || 'url(#barGrad)';
            bars += '<text class="bar-label" x="' + (labelW - 8) + '" y="' + (y + rowH / 2 + 4) + '" text-anchor="end">' + esc(truncate(d.label, 24)) + '</text>';
            bars += '<rect x="' + labelW + '" y="' + y + '" width="' + w + '" height="' + rowH + '" rx="6" fill="' + color + '"></rect>';
            bars += '<text class="val-label" x="' + (labelW + w + 8) + '" y="' + (y + rowH / 2 + 4) + '">' + esc(fmt(d.value)) + '</text>';
        });
        el.innerHTML = '<svg class="chart-svg" viewBox="0 0 ' + chartW + ' ' + H + '" preserveAspectRatio="xMinYMin meet" role="img">' +
            '<defs><linearGradient id="barGrad" x1="0" y1="0" x2="1" y2="0">' +
            '<stop offset="0%" stop-color="#00D4FF"/><stop offset="100%" stop-color="#4A9EF7"/></linearGradient></defs>' +
            bars + '</svg>';
    }

    // --------------------------------------------------- sortable table helper
    var tableRegistry = {};
    var tableSeq = 0;

    function sortableTable(columns, rows, sortKey, sortDir) {
        var id = 't' + (++tableSeq);
        tableRegistry[id] = { columns: columns, rows: rows, sortKey: sortKey, sortDir: sortDir || 'desc' };
        return '<div class="table-wrap" id="' + id + '"></div>';
    }

    function renderTable(id) {
        var t = tableRegistry[id];
        if (!t) return;
        var el = $(id);
        if (!el) return;
        var rows = t.rows.slice();
        if (t.sortKey) {
            rows.sort(function (a, b) {
                var av = a[t.sortKey], bv = b[t.sortKey];
                if (typeof av === 'number' && typeof bv === 'number') { return t.sortDir === 'asc' ? av - bv : bv - av; }
                av = String(av == null ? '' : av).toLowerCase(); bv = String(bv == null ? '' : bv).toLowerCase();
                if (av < bv) return t.sortDir === 'asc' ? -1 : 1;
                if (av > bv) return t.sortDir === 'asc' ? 1 : -1;
                return 0;
            });
        }
        var head = '<thead><tr>' + t.columns.map(function (c) {
            var arrow = t.sortKey === c.key ? (t.sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';
            return '<th class="sortable ' + (c.num ? 'num' : '') + '" data-table="' + id + '" data-key="' + esc(c.key) + '">' + esc(c.label) + arrow + '</th>';
        }).join('') + '</tr></thead>';
        var body = '<tbody>' + rows.map(function (r) {
            return '<tr>' + t.columns.map(function (c) {
                var raw = r[c.key];
                var cell = c.fmt ? c.fmt(raw, r) : esc(raw);
                var cls = (c.num ? 'num ' : '') + (c.cellClass ? c.cellClass(raw, r) : '');
                return '<td class="' + cls.trim() + '">' + cell + '</td>';
            }).join('') + '</tr>';
        }).join('') + '</tbody>';
        el.innerHTML = '<table>' + head + body + '</table>';
    }

    document.addEventListener('click', function (e) {
        var th = e.target.closest ? e.target.closest('th.sortable') : null;
        if (!th) return;
        var id = th.getAttribute('data-table');
        var key = th.getAttribute('data-key');
        var t = tableRegistry[id];
        if (!t) return;
        if (t.sortKey === key) { t.sortDir = t.sortDir === 'asc' ? 'desc' : 'asc'; }
        else { t.sortKey = key; t.sortDir = 'desc'; }
        renderTable(id);
    });

    function statusCellClass(v, r) {
        var s = r.status || r.budgetStatus;
        return s === 'Over' ? 'cell-over' : (s === 'Near' ? 'cell-near' : 'cell-under');
    }

    // ------------------------------------------------------------- views
    function renderView(tab) {
        state.activeTab = tab;
        Array.prototype.forEach.call(document.querySelectorAll('.tab-btn'), function (b) {
            b.classList.toggle('active', b.getAttribute('data-tab') === tab);
        });
        var c = $('viewContainer');
        var r = { exec: viewExec, group: viewGroup, cc: viewCC, opt: viewOpt, standout: viewStandout, cohorts: viewCohorts, users: viewUsers, focus: viewFocus, glossary: viewGlossary }[tab];
        r(c);
    }

    function header(title, desc) {
        return '<h2 class="view-title">' + esc(title) + '</h2><p class="view-desc">' + desc + '</p>';
    }

    function metricCard(label, value, sub, accent) {
        return '<div class="metric-card ' + (accent || '') + '"><div class="metric-label">' + esc(label) + '</div>' +
            '<div class="metric-value">' + esc(value) + '</div>' +
            (sub ? '<div class="metric-sublabel">' + esc(sub) + '</div>' : '') + '</div>';
    }

    function viewExec(c) {
        var org = state.computed.org, groups = state.computed.groups;
        var top = groups.slice(0, 12).map(function (g) { return { label: g.label, value: g.chargeback }; });
        c.innerHTML = header('Executive Overview', 'Headline chargeback is based on individual over-limit credits, priced at the current rate of ' + fmtMoney(state.rate) + ' per credit.') +
            '<div class="metrics-grid">' +
            metricCard('Users', fmtInt(org.userCount), org.licensedUsers + ' licensed') +
            metricCard('Total Credits Used', fmtInt(org.totalUsed), 'Avg ' + fmtNum2(org.avgCreditsPerUser) + '/user') +
            metricCard('Chargeback (overage $)', fmtMoney(org.chargeback), fmtInt(org.totalOverageCredits) + ' overage credits', 'accent-red') +
            metricCard('Utilization', fmtPct(org.utilization), fmtInt(org.totalUsed) + ' / ' + fmtInt(org.totalLimit), 'accent-amber') +
            metricCard('Users Over Limit', fmtInt(org.usersOverLimit), org.usersNearLimit + ' near, ' + org.usersWithinBudget + ' within', 'accent-red') +
            '</div>' +
            '<div class="panel"><h3>Chargeback by ' + esc(state.sliceBy) + ' (top 12)</h3><div id="execChart"></div></div>' +
            '<div class="panel"><h3>Group rollup</h3>' +
            sortableTable(groupColumns(), groups, 'chargeback', 'desc') + '</div>';
        horizontalBarChart($('execChart'), top, { valueFormat: fmtMoney });
        renderTable(tableIdFor(c));
    }

    function groupColumns() {
        return [
            { key: 'label', label: state.sliceBy },
            { key: 'userCount', label: 'Users', num: true, fmt: function (v) { return fmtInt(v); } },
            { key: 'totalUsed', label: 'Credits Used', num: true, fmt: function (v) { return fmtInt(v); } },
            { key: 'totalLimit', label: 'Allowance', num: true, fmt: function (v) { return fmtInt(v); } },
            { key: 'utilization', label: 'Utilization %', num: true, fmt: function (v) { return fmtPct(v); }, cellClass: statusCellClass },
            { key: 'chargeback', label: 'Chargeback $', num: true, fmt: function (v) { return fmtMoney(v); } },
            { key: 'chargebackPct', label: 'Chargeback %', num: true, fmt: function (v) { return fmtPct(v); } },
            { key: 'unusedCredits', label: 'Unused Credits', num: true, fmt: function (v) { return fmtInt(v); } }
        ];
    }

    // Find the last-registered table div id within a container (helper for single-table views).
    function tableIdFor(container) {
        var divs = container.querySelectorAll('.table-wrap');
        return divs.length ? divs[divs.length - 1].id : null;
    }

    function viewGroup(c) {
        var groups = state.computed.groups;
        var bar = groups.slice(0, 15).map(function (g) { return { label: g.label, value: g.chargeback }; });
        c.innerHTML = header('Chargeback by ' + esc(state.sliceBy), 'Full breakdown sorted by chargeback. Utilization is colored by budget status: green under, amber near (>=85%), red over.') +
            '<div class="panel"><h3>Chargeback $ by ' + esc(state.sliceBy) + '</h3><div id="grpChart"></div></div>' +
            '<div class="panel"><h3>Detail</h3>' + sortableTable(groupColumns(), groups, 'chargeback', 'desc') + '</div>';
        horizontalBarChart($('grpChart'), bar, { valueFormat: fmtMoney });
        renderTable(tableIdFor(c));
    }

    function viewCC(c) {
        var hasCC = state.dims.some(function (d) { return d.key === 'Cost Center'; });
        var hasBU = state.dims.some(function (d) { return d.key === 'Business Unit'; });
        var html = header('Cost Center & Business Unit', 'Chargeback rolled up by cost center and by business unit, independent of the current slice-by selection.');
        var au = state.computed.activeUsers;
        if (hasCC) {
            var ccGroups = aggregate(au, 'costCenter');
            html += '<div class="panel"><h3>By Cost Center</h3><div id="ccChart"></div>' +
                sortableTable(groupColumns2('Cost Center'), ccGroups, 'chargeback', 'desc') + '</div>';
        }
        if (hasBU) {
            var buGroups = aggregate(au, 'businessUnit');
            html += '<div class="panel"><h3>By Business Unit</h3><div id="buChart"></div>' +
                sortableTable(groupColumns2('Business Unit'), buGroups, 'chargeback', 'desc') + '</div>';
        }
        if (!hasCC && !hasBU) {
            html += '<div class="panel"><p class="panel-note">Neither a Cost Center nor a Business Unit column was found in the uploaded data, so this view has nothing to show.</p></div>';
        }
        c.innerHTML = html;
        if (hasCC) {
            var ccG = aggregate(au, 'costCenter').slice(0, 12).map(function (g) { return { label: g.label, value: g.chargeback }; });
            horizontalBarChart($('ccChart'), ccG, { valueFormat: fmtMoney });
        }
        if (hasBU) {
            var buG = aggregate(au, 'businessUnit').slice(0, 12).map(function (g) { return { label: g.label, value: g.chargeback }; });
            horizontalBarChart($('buChart'), buG, { valueFormat: fmtMoney });
        }
        // Render every table in this view.
        Array.prototype.forEach.call(c.querySelectorAll('.table-wrap'), function (d) { renderTable(d.id); });
    }

    function groupColumns2(label) { var cols = groupColumns(); cols[0].label = label; return cols; }

    function viewOpt(c) {
        var au = state.computed.activeUsers;
        var field = dimField(state.sliceBy);
        var groups = aggregate(au, field);
        var org = state.computed.org;
        var offset = Math.min(org.totalUnusedCredits, org.totalOverageCredits) * state.rate;
        var cols = [
            { key: 'label', label: state.sliceBy },
            { key: 'userCount', label: 'Users', num: true, fmt: fmtInt },
            { key: 'unusedCredits', label: 'Unused (headroom)', num: true, fmt: fmtInt },
            { key: 'overageCredits', label: 'Overage', num: true, fmt: fmtInt },
            { key: 'chargeback', label: 'Chargeback $', num: true, fmt: function (v) { return fmtMoney(v); } }
        ];
        c.innerHTML = header('Optimization (this month)', 'This is a current-month snapshot, not a forecast. It contrasts unused headroom against over-limit spend.') +
            '<div class="info-box"><p>Across all groups there are <strong>' + fmtInt(org.totalUnusedCredits) + '</strong> unused credits of headroom and <strong>' + fmtInt(org.totalOverageCredits) + '</strong> overage credits. Reallocating headroom toward over-limit groups could offset up to <strong>' + fmtMoney(offset) + '</strong> of chargeback this month.</p></div>' +
            '<div class="panel"><h3>Unused headroom by ' + esc(state.sliceBy) + '</h3><div id="optUnused"></div></div>' +
            '<div class="panel"><h3>Overage by ' + esc(state.sliceBy) + '</h3><div id="optOver"></div></div>' +
            '<div class="panel"><h3>Detail</h3>' + sortableTable(cols, groups, 'overageCredits', 'desc') + '</div>';
        var unusedData = groups.slice().sort(function (a, b) { return b.unusedCredits - a.unusedCredits; }).slice(0, 12)
            .map(function (g) { return { label: g.label, value: g.unusedCredits, color: '#34D399' }; });
        var overData = groups.slice().sort(function (a, b) { return b.overageCredits - a.overageCredits; }).slice(0, 12)
            .map(function (g) { return { label: g.label, value: g.overageCredits, color: '#F87171' }; });
        horizontalBarChart($('optUnused'), unusedData, { valueFormat: fmtInt });
        horizontalBarChart($('optOver'), overData, { valueFormat: fmtInt });
        renderTable(tableIdFor(c));
    }

    function viewStandout(c) {
        var top = state.users.slice().sort(function (a, b) { return b.standout - a.standout; }).slice(0, 25);
        var cols = [
            { key: 'displayName', label: 'User', fmt: function (v, r) { return (r.star ? '<span class="star">\u2605</span> ' : '') + esc(v); } },
            { key: 'department', label: 'Department' },
            { key: 'used', label: 'Credits Used', num: true, fmt: fmtInt },
            { key: 'deptAvg', label: 'Dept Avg', num: true, fmt: function (v) { return fmtNum2(v); } },
            { key: 'standout', label: 'Standout Ratio', num: true, fmt: function (v) { return fmtNum2(v) + 'x'; } }
        ];
        c.innerHTML = header('Standout Individuals', 'Users whose usage most exceeds their department average. A star marks a standout ratio of 2x or higher.') +
            '<div class="panel"><h3>Top standout ratio</h3><div id="stdChart"></div></div>' +
            '<div class="panel"><h3>Top 25 individuals</h3>' + sortableTable(cols, top, 'standout', 'desc') + '</div>';
        horizontalBarChart($('stdChart'), top.slice(0, 12).map(function (u) { return { label: u.displayName, value: u.standout }; }), { valueFormat: function (v) { return fmtNum2(v) + 'x'; } });
        renderTable(tableIdFor(c));
    }

    function viewCohorts(c) {
        var stats = state.computed.cohorts;
        var cols = [
            { key: 'cohort', label: 'Cohort' },
            { key: 'users', label: 'Users', num: true, fmt: fmtInt },
            { key: 'pct', label: '% of Users', num: true, fmt: function (v) { return fmtPct(v); } },
            { key: 'totalUsed', label: 'Total Credits Used', num: true, fmt: fmtInt },
            { key: 'avg', label: 'Avg per User', num: true, fmt: function (v) { return fmtNum2(v); } }
        ];
        c.innerHTML = header('Usage Cohorts', 'Users grouped into six tiers by their percentile of credits used across the whole population.') +
            '<div class="panel"><h3>Users per cohort</h3><div id="cohortChart"></div></div>' +
            '<div class="panel"><h3>Cohort breakdown</h3>' + sortableTable(cols, stats, null, 'desc') + '</div>';
        horizontalBarChart($('cohortChart'), stats.map(function (s) { return { label: s.cohort, value: s.users }; }), { valueFormat: fmtInt });
        renderTable(tableIdFor(c));
    }

    function viewUsers(c) {
        var CAP = 500;
        c.innerHTML = header('User Detail', 'Per-user usage, overage, and chargeback. Type to filter by name, UPN, or department.') +
            '<div class="panel"><input type="text" id="userSearch" class="search-box" placeholder="Search name, UPN, or department..."><div id="userTableWrap"></div><p class="row-note" id="userNote"></p></div>';
        var cols = [
            { key: 'displayName', label: 'Display Name' },
            { key: 'upn', label: 'UPN' },
            { key: 'department', label: 'Department' },
            { key: 'used', label: 'Credits Used', num: true, fmt: fmtInt },
            { key: 'limit', label: 'Limit', num: true, fmt: fmtInt },
            { key: 'util', label: 'Utilization %', num: true, fmt: function (v) { return fmtPct(v); }, cellClass: statusCellClass },
            { key: 'overage', label: 'Overage', num: true, fmt: fmtInt },
            { key: 'chargeback', label: 'Chargeback $', num: true, fmt: function (v) { return fmtMoney(v); } },
            { key: 'cohort', label: 'Cohort' },
            { key: 'licensed', label: 'License', fmt: function (v) { return v ? 'Yes' : 'No'; } }
        ];
        function draw(filter) {
            var rows = state.users;
            if (filter) {
                var f = filter.toLowerCase();
                rows = rows.filter(function (u) {
                    return (u.displayName + ' ' + u.upn + ' ' + u.department).toLowerCase().indexOf(f) >= 0;
                });
            }
            var total = rows.length;
            var shown = rows.slice(0, CAP);
            var wrap = $('userTableWrap');
            var html = sortableTable(cols, shown, 'chargeback', 'desc');
            wrap.innerHTML = html;
            renderTable(tableIdFor(wrap.parentNode) || wrap.querySelector('.table-wrap').id);
            $('userNote').textContent = total > CAP ? ('Showing first ' + CAP + ' of ' + fmtInt(total) + ' matching users.') : ('Showing all ' + fmtInt(total) + ' matching users.');
        }
        draw('');
        $('userSearch').addEventListener('input', function () { draw(this.value); });
    }

    function viewFocus(c) {
        var f = state.computed.focus;
        var same = Math.abs(state.rate - 0.01) < 1e-9;
        c.innerHTML = header('FOCUS Cost View', 'FinOps FOCUS-style cost columns derived from org credits used at the current rate.') +
            '<div class="metrics-grid">' +
            metricCard('List Cost', fmtMoney(f.listCost), 'at $0.01/credit') +
            metricCard('Contracted Cost', fmtMoney(f.contractedCost), 'at ' + fmtMoney(state.rate) + '/credit') +
            metricCard('Effective Cost', fmtMoney(f.effectiveCost), '= contracted') +
            metricCard('Billed Cost', fmtMoney(f.billedCost), '= contracted') +
            metricCard('Savings vs List', fmtMoney(f.savingsVsList), same ? 'zero at list rate' : 'from rate discount', f.savingsVsList > 0 ? 'accent-green' : '') +
            '</div>' +
            '<div class="info-box"><p>' + (same
                ? 'At the default rate of $0.01/credit, List and Contracted costs are equal, so savings versus list is $0. Lower the rate with the what-if to see savings diverge.'
                : 'Because the contracted rate (' + fmtMoney(state.rate) + ') differs from the $0.01 list rate, contracted cost diverges from list and produces the savings shown above.') + '</p></div>';
    }

    function viewGlossary(c) {
        var rows = [
            ['Chargeback (overage-based)', 'The headline dollar figure. Sum of each user\'s over-limit credits (max(0, used - limit)) multiplied by the rate per credit. Groups are charged for individual overage, not group totals.'],
            ['Utilization', 'Credits used divided by allowance. Colored green when under 85%, amber at 85-100% (near), red above 100% (over).'],
            ['Usage Cohorts', 'Six tiers by percentile of credits used across all users: Light (&le;50th), Regular (&le;75th), Engaged (&le;90th), Native (&le;95th), Power (&le;99th), Frontier (top 1%).'],
            ['Standout Ratio', 'A user\'s credits used divided by their department average. A ratio of 2x or higher earns a star.'],
            ['Slice By', 'The dimension used to group the report: Department, Business Unit, Job Family, Job Title, Cost Center, Country, or Manager (only dimensions present in the data are offered).'],
            ['FOCUS columns', 'List = used x $0.01; Contracted / Effective / Billed = used x current rate; Savings vs List = list minus contracted.'],
            ['Rate per credit', 'The single knob that converts credits to dollars. Every dollar figure in this report derives from it.']
        ];
        var notes = [
            'This is a single-month snapshot. There is no forecast or trend.',
            'Every dollar figure derives from the rate knob; change it and all $ update live.',
            'Users in the credit file without an Entra match are counted with department "Unknown".',
            (state.usedFallbackLimit ? 'The credit file had no per-user limit column, so a fallback limit of ' + fmtInt(state.fallbackLimit) + ' credits was applied to every user.' : 'Per-user credit limits were read directly from the credit file.'),
            (state.demoActive ? 'DEMO DATA is active - all figures are synthetic and must not be used for real decisions.' : 'Figures reflect the files you uploaded; processing happened entirely in your browser.')
        ];
        c.innerHTML = header('Glossary / Notes', 'Definitions and honesty notes for this report.') +
            '<div class="panel"><h3>Definitions</h3><div class="table-wrap"><table class="glossary-table"><tbody>' +
            rows.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + r[1] + '</td></tr>'; }).join('') +
            '</tbody></table></div></div>' +
            '<div class="panel"><h3>Honesty notes</h3><ul style="margin-left:1.25rem">' +
            notes.map(function (n) { return '<li style="margin-bottom:0.5rem">' + n + '</li>'; }).join('') + '</ul></div>' +
            '<div class="info-box privacy-box"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg><p><strong>Privacy:</strong> All processing happens locally in your browser. Your files never leave your device. No telemetry, no uploads.</p></div>';
    }

    // --------------------------------------------------------------- exports
    function exportDeck() {
        if (!window.PptxGenJS) { alert('PPTX library not loaded.'); return; }
        var org = state.computed.org, groups = state.computed.groups, cohorts = state.computed.cohorts;
        var pptx = new window.PptxGenJS();
        pptx.defineLayout({ name: 'W', width: 13.33, height: 7.5 });
        pptx.layout = 'W';
        var BG = '0B1120', SURF = '1E293B', BLUE = '4A9EF7', CYAN = '00D4FF', TXT = 'F1F5F9', SUB = '94A3B8', RED = 'F87171';
        var demoNote = state.demoActive ? '  |  SYNTHETIC DEMO DATA' : '';

        function bg(s) { s.background = { color: BG }; }

        // Title slide
        var s1 = pptx.addSlide(); bg(s1);
        s1.addText('Copilot Cowork Credit Chargeback', { x: 0.7, y: 2.2, w: 12, h: 1, fontFace: 'Segoe UI', fontSize: 40, bold: true, color: CYAN });
        s1.addText('Headline chargeback: ' + fmtMoney(org.chargeback) + '  (' + fmtInt(org.totalOverageCredits) + ' overage credits @ ' + fmtMoney(state.rate) + '/credit)', { x: 0.7, y: 3.3, w: 12, h: 0.6, fontFace: 'Segoe UI', fontSize: 20, color: TXT });
        s1.addText(new Date().toLocaleDateString() + demoNote, { x: 0.7, y: 4.1, w: 12, h: 0.5, fontFace: 'Segoe UI', fontSize: 14, color: SUB });

        // Executive summary
        var s2 = pptx.addSlide(); bg(s2);
        s2.addText('Executive Summary', { x: 0.7, y: 0.4, w: 12, h: 0.7, fontSize: 28, bold: true, color: BLUE, fontFace: 'Segoe UI' });
        var kpis = [
            ['Users', fmtInt(org.userCount)], ['Total credits used', fmtInt(org.totalUsed)],
            ['Chargeback (overage $)', fmtMoney(org.chargeback)], ['Utilization', fmtPct(org.utilization)],
            ['Users over limit', fmtInt(org.usersOverLimit)]
        ];
        kpis.forEach(function (k, i) {
            var x = 0.7 + (i % 3) * 4.2, y = 1.5 + Math.floor(i / 3) * 1.7;
            s2.addShape(pptx.ShapeType.roundRect, { x: x, y: y, w: 3.9, h: 1.5, fill: { color: SURF }, line: { color: BLUE, width: 0.5 }, rectRadius: 0.1 });
            s2.addText(k[0], { x: x + 0.2, y: y + 0.15, w: 3.5, h: 0.4, fontSize: 12, color: SUB, fontFace: 'Segoe UI' });
            s2.addText(k[1], { x: x + 0.2, y: y + 0.55, w: 3.5, h: 0.7, fontSize: 26, bold: true, color: CYAN, fontFace: 'Segoe UI' });
        });
        s2.addText('Chargeback is overage-based: each user is billed only for credits used above their limit, priced at ' + fmtMoney(state.rate) + ' per credit.', { x: 0.7, y: 5.2, w: 12, h: 0.8, fontSize: 14, color: TXT, fontFace: 'Segoe UI' });

        // Chargeback by dimension chart
        var s3 = pptx.addSlide(); bg(s3);
        s3.addText('Chargeback by ' + state.sliceBy, { x: 0.7, y: 0.4, w: 12, h: 0.7, fontSize: 28, bold: true, color: BLUE, fontFace: 'Segoe UI' });
        var topN = groups.slice(0, 10);
        s3.addChart(pptx.ChartType.bar, [{ name: 'Chargeback', labels: topN.map(function (g) { return g.label; }), values: topN.map(function (g) { return Math.round(g.chargeback * 100) / 100; }) }],
            { x: 0.7, y: 1.3, w: 12, h: 5.6, barDir: 'bar', showValue: true, chartColors: [CYAN], catAxisLabelColor: TXT, valAxisLabelColor: SUB, dataLabelColor: TXT, showLegend: false, valAxisLabelFormatCode: '$#,##0' });

        // Group table
        var s4 = pptx.addSlide(); bg(s4);
        s4.addText(state.sliceBy + ' Detail (top 12)', { x: 0.7, y: 0.4, w: 12, h: 0.7, fontSize: 28, bold: true, color: BLUE, fontFace: 'Segoe UI' });
        var trows = [[
            { text: state.sliceBy, options: { bold: true, color: BLUE } }, { text: 'Users', options: { bold: true, color: BLUE } },
            { text: 'Used', options: { bold: true, color: BLUE } }, { text: 'Allowance', options: { bold: true, color: BLUE } },
            { text: 'Util %', options: { bold: true, color: BLUE } }, { text: 'Chargeback', options: { bold: true, color: BLUE } }
        ]];
        groups.slice(0, 12).forEach(function (g) {
            trows.push([g.label, fmtInt(g.userCount), fmtInt(g.totalUsed), fmtInt(g.totalLimit), fmtPct(g.utilization), fmtMoney(g.chargeback)]);
        });
        s4.addTable(trows, { x: 0.7, y: 1.4, w: 12, color: TXT, fontFace: 'Segoe UI', fontSize: 12, border: { type: 'solid', color: '334155', pt: 0.5 }, fill: { color: SURF } });

        // Cohort slide
        var s5 = pptx.addSlide(); bg(s5);
        s5.addText('Usage Cohorts', { x: 0.7, y: 0.4, w: 12, h: 0.7, fontSize: 28, bold: true, color: BLUE, fontFace: 'Segoe UI' });
        s5.addChart(pptx.ChartType.bar, [{ name: 'Users', labels: cohorts.map(function (c) { return c.cohort; }), values: cohorts.map(function (c) { return c.users; }) }],
            { x: 0.7, y: 1.3, w: 12, h: 5.6, barDir: 'bar', showValue: true, chartColors: [BLUE], catAxisLabelColor: TXT, valAxisLabelColor: SUB, dataLabelColor: TXT, showLegend: false });

        // Methodology
        var s6 = pptx.addSlide(); bg(s6);
        s6.addText('Methodology & Notes', { x: 0.7, y: 0.4, w: 12, h: 0.7, fontSize: 28, bold: true, color: BLUE, fontFace: 'Segoe UI' });
        var method = [
            'Rate per credit: ' + fmtMoney(state.rate) + ' (adjustable what-if).',
            'Chargeback = sum of per-user max(0, used - limit) x rate.',
            'Utilization = credits used / allowance.',
            'Cohorts are percentile tiers of credits used across all users.',
            'Single-month snapshot; no forecast.',
            (state.usedFallbackLimit ? 'Fallback limit of ' + fmtInt(state.fallbackLimit) + ' applied (no limit column found).' : 'Per-user limits read from the credit file.'),
            (state.demoActive ? 'SYNTHETIC DEMO DATA - not for real decisions.' : 'Computed locally in-browser from uploaded files.')
        ];
        s6.addText(method.map(function (m) { return { text: m, options: { bullet: true, color: TXT, fontSize: 16, fontFace: 'Segoe UI', paraSpaceAfter: 8 } }; }), { x: 0.9, y: 1.5, w: 11.5, h: 5 });

        pptx.writeFile({ fileName: 'Cowork_Credit_Chargeback.pptx' });
    }

    function exportPdf() {
        if (!window.jspdf || !window.html2canvas) { alert('PDF libraries not loaded.'); return; }
        var jsPDF = window.jspdf.jsPDF;
        var pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
        var views = ['exec', 'group'];
        var prev = state.activeTab;
        var idx = 0;

        function step() {
            if (idx >= views.length) {
                renderView(prev);
                pdf.save('Cowork_Credit_Chargeback.pdf');
                return;
            }
            renderView(views[idx]);
            setTimeout(function () {
                var el = $('viewContainer');
                window.html2canvas(el, { backgroundColor: '#0B1120', scale: 2, logging: false }).then(function (canvas) {
                    var pw = pdf.internal.pageSize.getWidth();
                    var ph = pdf.internal.pageSize.getHeight();
                    var ratio = Math.min((pw - 40) / canvas.width, (ph - 40) / canvas.height);
                    var w = canvas.width * ratio, h = canvas.height * ratio;
                    if (idx > 0) pdf.addPage();
                    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', (pw - w) / 2, 20, w, h);
                    idx++;
                    step();
                });
            }, 80);
        }
        step();
    }

    // --------------------------------------------------- dashboard scaffolding
    function buildTabs() {
        $('tabNav').innerHTML = TABS.map(function (t) {
            return '<button class="tab-btn' + (t.id === 'exec' ? ' active' : '') + '" data-tab="' + t.id + '">' + esc(t.label) + '</button>';
        }).join('');
        Array.prototype.forEach.call(document.querySelectorAll('.tab-btn'), function (b) {
            b.addEventListener('click', function () { renderView(b.getAttribute('data-tab')); });
        });
    }

    function buildSliceBy() {
        var sel = $('sliceBy');
        sel.innerHTML = state.dims.map(function (d) { return '<option value="' + esc(d.key) + '"' + (d.key === state.sliceBy ? ' selected' : '') + '>' + esc(d.key) + '</option>'; }).join('');
        sel.onchange = function () { state.sliceBy = sel.value; save('cowork_sliceBy', sel.value); refresh(); };
    }

    function buildCohortToggles() {
        var box = $('cohortToggles');
        box.innerHTML = COHORT_ORDER.map(function (c) {
            var on = state.cohortFilter[c] !== false;
            return '<button class="cohort-chip' + (on ? ' on' : '') + '" data-cohort="' + c + '">' + c + '</button>';
        }).join('');
        Array.prototype.forEach.call(box.querySelectorAll('.cohort-chip'), function (chip) {
            chip.addEventListener('click', function () {
                var c = chip.getAttribute('data-cohort');
                state.cohortFilter[c] = state.cohortFilter[c] === false ? true : false;
                chip.classList.toggle('on', state.cohortFilter[c] !== false);
                refresh();
            });
        });
    }

    function buildRailMeta() {
        var m = state.usedFallbackLimit ? ('Fallback limit ' + fmtInt(state.fallbackLimit) + ' applied.') : 'Limits from credit file.';
        $('railMeta').textContent = state.users.length + ' users loaded. ' + m;
    }

    function refresh() {
        compute();
        renderView(state.activeTab);
        buildRailMeta();
        var org = state.computed.org;
        $('topbarSub').textContent = fmtInt(org.userCount) + ' users  |  ' + fmtMoney(org.chargeback) + ' chargeback  |  sliced by ' + state.sliceBy;
    }

    function showDashboard() {
        state.dims = detectDims(state.users);
        if (!state.dims.some(function (d) { return d.key === state.sliceBy; })) {
            state.dims.forEach(function () {});
            state.sliceBy = state.dims.length ? state.dims[0].key : 'Department';
        }
        COHORT_ORDER.forEach(function (c) { if (state.cohortFilter[c] === undefined) state.cohortFilter[c] = true; });
        $('landing').hidden = true;
        $('dashboard').hidden = false;
        $('demoBanner').hidden = !state.demoActive;
        $('dashFooter').innerHTML = state.demoActive ? '<p>Synthetic demo data - not for real decisions. <a href="PRIVACY.md">Privacy</a></p>' : '<p>100% client-side. <a href="PRIVACY.md">Privacy</a></p>';
        $('rateWhatIf').value = state.rate;
        buildTabs();
        buildSliceBy();
        buildCohortToggles();
        state.activeTab = 'exec';
        refresh();
        window.scrollTo(0, 0);
    }

    function startFrom(entraRows, creditRows, demo) {
        state.entraRows = entraRows;
        state.creditRows = creditRows;
        state.demoActive = !!demo;
        state.rate = parseFloat($('rateInput').value) || 0.01;
        state.fallbackLimit = parseFloat($('fallbackLimit').value) || 400;
        var savedRate = load('cowork_rate');
        if (savedRate) state.rate = parseFloat(savedRate) || state.rate;
        var savedSlice = load('cowork_sliceBy');
        if (savedSlice) state.sliceBy = savedSlice;
        state.users = buildUsers(entraRows, creditRows);
        if (!state.users.length) { showError('No users could be built from these files. Check that the credit file has a user principal name column.'); return; }
        showDashboard();
    }

    // ------------------------------------------------------------ persistence
    function save(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
    function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

    // ------------------------------------------------------------ landing wiring
    function showError(msg) {
        var e = $('landingError');
        if (!e) { alert(msg); return; }
        e.textContent = msg; e.hidden = false;
    }

    function readFile(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result)); };
            reader.onerror = function () { reject(new Error('Could not read file')); };
            reader.readAsText(file);
        });
    }

    function wireDropzone(dzId, inputId, statusId, which) {
        var dz = $(dzId), input = $(inputId), status = $(statusId);
        dz.addEventListener('click', function () { input.click(); });
        dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('dragover'); });
        dz.addEventListener('dragleave', function () { dz.classList.remove('dragover'); });
        dz.addEventListener('drop', function (e) {
            e.preventDefault(); dz.classList.remove('dragover');
            if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0], dz, status, which);
        });
        input.addEventListener('change', function () { if (input.files[0]) handleFile(input.files[0], dz, status, which); });
    }

    function handleFile(file, dz, status, which) {
        $('landingError').hidden = true;
        readFile(file).then(function (text) {
            var rows = parseCSV(text);
            state.pending[which] = rows;
            status.textContent = file.name + ' - ' + fmtInt(rows.length) + ' rows';
            dz.classList.add('loaded');
            $('btnGenerate').disabled = !(state.pending.entra && state.pending.credits);
        }).catch(function () { showError('Failed to read ' + file.name); });
    }

    function loadDemo() {
        if (!window.DEMO_ENTRA_CSV || !window.DEMO_CREDITS_CSV) { showError('Demo data not available.'); return; }
        startFrom(parseCSV(window.DEMO_ENTRA_CSV), parseCSV(window.DEMO_CREDITS_CSV), true);
    }

    function reset() {
        state.pending = { entra: null, credits: null };
        state.users = []; state.computed = null; state.demoActive = false;
        $('dashboard').hidden = true;
        $('landing').hidden = false;
        $('statusEntra').textContent = 'No file selected';
        $('statusCredits').textContent = 'No file selected';
        $('dzEntra').classList.remove('loaded');
        $('dzCredits').classList.remove('loaded');
        $('fileEntra').value = ''; $('fileCredits').value = '';
        $('btnGenerate').disabled = true;
        window.scrollTo(0, 0);
    }

    function init() {
        // Restore persisted config.
        var savedRate = load('cowork_rate');
        if (savedRate) $('rateInput').value = savedRate;

        wireDropzone('dzEntra', 'fileEntra', 'statusEntra', 'entra');
        wireDropzone('dzCredits', 'fileCredits', 'statusCredits', 'credits');

        $('btnGenerate').addEventListener('click', function () {
            if (state.pending.entra && state.pending.credits) startFrom(state.pending.entra, state.pending.credits, false);
        });
        $('btnDemo').addEventListener('click', loadDemo);
        $('rateInput').addEventListener('change', function () { save('cowork_rate', this.value); });

        $('rateWhatIf').addEventListener('input', function () {
            var v = parseFloat(this.value);
            if (isFinite(v) && v >= 0) { state.rate = v; save('cowork_rate', v); refresh(); }
        });
        $('btnDeck').addEventListener('click', exportDeck);
        $('btnPdf').addEventListener('click', exportPdf);
        $('btnReset').addEventListener('click', reset);

        // ?demo=1 auto-load.
        if (/[?&]demo=1\b/.test(location.search)) loadDemo();

        // Service worker (guard file://).
        if ('serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:')) {
            navigator.serviceWorker.register('sw.js').catch(function () { });
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    // Expose a few internals for testing/console use.
    window.CoworkApp = { parseCSV: parseCSV, buildUsers: buildUsers, compute: compute, aggregate: aggregate, state: state };
})();
