// ---------- Model ----------
const STORAGE_KEY = "assignmentPlanner.state";
const NOTIFY_WINDOW_MS = 24 * 60 * 60 * 1000; // schedule only if within next 24h

/**
 * @typedef {Object} Assignment
 * @property {string} id
 * @property {string} title
 * @property {string} course
 * @property {string} dueDate      // YYYY-MM-DD
 * @property {string} dueTime      // HH:MM or ""
 * @property {"High"|"Medium"|"Low"} priority
 * @property {number} estimateHours
 * @property {"todo"|"doing"|"done"} status
 * @property {string} notes
 * @property {number} remindAheadMinutes  // -1 for none
 * @property {number|null} notifiedAt     // timestamp when notification fired
 * @property {number|null} scheduledAt    // computed timestamp for reminder
 * @property {number} createdAt
 * @property {number} updatedAt
 */

const state = {
    /** @type {Assignment[]} */
    items: [],
    filters: {
        search: "",
        course: "",
        priority: "",
        status: "",
        hideDone: false,
        sort: "dueAsc",
    },
};

// timers per id (so we can cancel if edited/done)
const scheduledTimers = new Map();

// ---------- Elements ----------
const yearSpan = document.getElementById("year");
yearSpan.textContent = String(new Date().getFullYear());

const toastEl = document.getElementById("toast");
function toast(msg, isError = false) {
    toastEl.textContent = msg;
    toastEl.style.borderColor = isError ? "#5a1d1d" : "#232733";
    toastEl.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove("show"), 2000);
}

// const rowsContainer = document.getElementById("rowsContainer");
const rowsTbody = document.getElementById("rowsTbody");

// Form inputs
const titleInput = document.getElementById("titleInput");
const courseInput = document.getElementById("courseInput");
const dueDateInput = document.getElementById("dueDateInput");
const dueTimeInput = document.getElementById("dueTimeInput");
const priorityInput = document.getElementById("priorityInput");
const estimateInput = document.getElementById("estimateInput");
const notesInput = document.getElementById("notesInput");
const reminderAheadInput = document.getElementById("reminderAheadInput");
const statusInput = document.getElementById("statusInput");
const createForm = document.getElementById("createForm");
const resetFormBtn = document.getElementById("resetFormBtn");

// Filters
const searchInput = document.getElementById("searchInput");
const filterCourse = document.getElementById("filterCourse");
const filterPriority = document.getElementById("filterPriority");
const filterStatus = document.getElementById("filterStatus");
const hideDoneCheck = document.getElementById("hideDoneCheck");
const sortSelect = document.getElementById("sortSelect");
const clearFiltersBtn = document.getElementById("clearFiltersBtn");

// Header actions
const notifyPermissionBtn = document.getElementById("notifyPermissionBtn");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const importCsvInput = document.getElementById("importCsvInput");
const printBtn = document.getElementById("printBtn");
const clearAllBtn = document.getElementById("clearAllBtn");

// KPIs
const kpiTotal = document.getElementById("kpiTotal");
const kpiTodo = document.getElementById("kpiTodo");
const kpiDoing = document.getElementById("kpiDoing");
const kpiDone = document.getElementById("kpiDone");
const kpiOverdue = document.getElementById("kpiOverdue");

// Edit dialog elements
const editDialog = document.getElementById("editDialog");
const editId = document.getElementById("editId");
const editTitle = document.getElementById("editTitle");
const editCourse = document.getElementById("editCourse");
const editDate = document.getElementById("editDate");
const editTime = document.getElementById("editTime");
const editPriority = document.getElementById("editPriority");
const editEstimate = document.getElementById("editEstimate");
const editStatus = document.getElementById("editStatus");
const editNotes = document.getElementById("editNotes");
const editReminder = document.getElementById("editReminder");
const saveBtn = document.getElementById("saveBtn");
const deleteBtn = document.getElementById("deleteBtn");

// ---------- Utilities ----------
const byId = (id) => state.items.find((a) => a.id === id);

function uid(prefix = "id") {
    return `${prefix}_${Math.random()
        .toString(36)
        .slice(2, 8)}_${Date.now().toString(36)}`;
}
function nowTs() {
    return Date.now();
}

function dueTimestamp(assignment) {
    const date = assignment.dueDate;
    let time = assignment.dueTime || "23:59";
    const [hh, mm] = time.split(":").map(Number);
    const dt = new Date(date);
    if (Number.isFinite(hh) && Number.isFinite(mm)) {
        dt.setHours(hh, mm, 0, 0);
    }
    return dt.getTime();
}

function scheduledReminderTs(assignment) {
    if (assignment.remindAheadMinutes < 0) return null;
    return dueTimestamp(assignment) - assignment.remindAheadMinutes * 60 * 1000;
}

function isOverdue(assignment) {
    return assignment.status !== "done" && dueTimestamp(assignment) < nowTs();
}
function isDueSoon(assignment) {
    const ts = dueTimestamp(assignment);
    const msLeft = ts - nowTs();
    return (
        assignment.status !== "done" &&
        msLeft > 0 &&
        msLeft <= 6 * 60 * 60 * 1000
    ); // 6h
}

function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
        const parsed = JSON.parse(raw);
        if (parsed?.items) state.items = parsed.items;
        if (parsed?.filters)
            state.filters = { ...state.filters, ...parsed.filters };
    } catch {}
}

// ---------- Notifications ----------
function updateNotifyButton() {
    if (!("Notification" in window)) {
        notifyPermissionBtn.textContent = "🔔 Not supported";
        notifyPermissionBtn.disabled = true;
        return;
    }
    if (Notification.permission === "granted") {
        notifyPermissionBtn.textContent = "🔔 Reminders On";
        notifyPermissionBtn.classList.remove("btn");
        notifyPermissionBtn.classList.add("btn-primary");
    } else if (Notification.permission === "denied") {
        notifyPermissionBtn.textContent = "🔕 Reminders Blocked";
        notifyPermissionBtn.disabled = true;
    } else {
        notifyPermissionBtn.textContent = "🔔 Enable Reminders";
    }
}

function fireNotification(assignment) {
    if (!("Notification" in window) || Notification.permission !== "granted")
        return;
    const due = new Date(dueTimestamp(assignment));
    const dueLabel = due.toLocaleString([], {
        dateStyle: "medium",
        timeStyle: assignment.dueTime ? "short" : undefined,
    });
    new Notification(`Due soon: ${assignment.title}`, {
        body: `${assignment.course || "Course"} · ${dueLabel}`,
        tag: `assignment-${assignment.id}`,
    });
    assignment.notifiedAt = nowTs();
    saveState();
}

function cancelTimerFor(id) {
    const t = scheduledTimers.get(id);
    if (t) {
        clearTimeout(t);
        scheduledTimers.delete(id);
    }
}

function scheduleReminder(assignment) {
    cancelTimerFor(assignment.id);
    const ts = scheduledReminderTs(assignment);
    assignment.scheduledAt = ts;
    if (!ts) return; // none
    const delay = ts - nowTs();
    if (delay <= 0) return; // past

    // only schedule in current tab if within next 24h
    if (delay <= NOTIFY_WINDOW_MS) {
        const handle = setTimeout(() => {
            scheduledTimers.delete(assignment.id);
            // skip if marked done meanwhile
            const fresh = byId(assignment.id);
            if (!fresh || fresh.status === "done") return;
            fireNotification(fresh);
        }, delay);
        scheduledTimers.set(assignment.id, handle);
    }
}

// reschedule everything on boot (for near-term)
function rescheduleAll() {
    scheduledTimers.forEach((h) => clearTimeout(h));
    scheduledTimers.clear();
    state.items.forEach((a) => {
        if (a.remindAheadMinutes >= 0 && a.status !== "done")
            scheduleReminder(a);
    });
}

// ---------- CSV helpers ----------
const CSV_HEADERS = [
    "title",
    "course",
    "dueDate",
    "dueTime",
    "priority",
    "estimateHours",
    "status",
    "notes",
    "remindAheadMinutes",
];

// escape for CSV
function csvEscape(value) {
    const s = String(value ?? "");
    if (s.includes('"') || s.includes(",") || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}
function toCSV(items) {
    const head = CSV_HEADERS.join(",");
    const lines = items.map((a) =>
        CSV_HEADERS.map((h) => csvEscape(a[h])).join(",")
    );
    return [head, ...lines].join("\n");
}

// Parse one CSV line with quotes support
function parseCsvLine(line) {
    const out = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                current += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ",") {
                out.push(current);
                current = "";
            } else {
                current += ch;
            }
        }
    }
    out.push(current);
    return out;
}

function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
    if (!lines.length) return [];
    const header = parseCsvLine(lines[0]).map((h) => h.trim());
    const idxMap = CSV_HEADERS.map((h) => header.indexOf(h));
    const items = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        const rec = {};
        CSV_HEADERS.forEach((h, j) => {
            const idx = idxMap[j];
            rec[h] = idx >= 0 ? cols[idx] : "";
        });
        const a = /** @type {Assignment} */ ({
            id: uid("asg"),
            title: rec.title,
            course: rec.course,
            dueDate: rec.dueDate,
            dueTime: rec.dueTime,
            priority: ["High", "Medium", "Low"].includes(rec.priority)
                ? rec.priority
                : "Medium",
            estimateHours: Number(rec.estimateHours) || 0,
            status: ["todo", "doing", "done"].includes(rec.status)
                ? rec.status
                : "todo",
            notes: rec.notes || "",
            remindAheadMinutes: Number(rec.remindAheadMinutes ?? -1),
            notifiedAt: null,
            scheduledAt: null,
            createdAt: nowTs(),
            updatedAt: nowTs(),
        });
        items.push(a);
    }
    return items;
}

// ---------- Rendering ----------
function renderKPIs() {
    const total = state.items.length;
    const todo = state.items.filter((a) => a.status === "todo").length;
    const doing = state.items.filter((a) => a.status === "doing").length;
    const done = state.items.filter((a) => a.status === "done").length;
    const overdue = state.items.filter((a) => isOverdue(a)).length;
    kpiTotal.textContent = total;
    kpiTodo.textContent = todo;
    kpiDoing.textContent = doing;
    kpiDone.textContent = done;
    kpiOverdue.textContent = overdue;
}

function uniqueCourses() {
    const set = new Set(state.items.map((a) => a.course).filter(Boolean));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
}
function hydrateCourseFilter() {
    const current = filterCourse.value;
    filterCourse.innerHTML = `<option value="">All courses</option>`;
    uniqueCourses().forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = c;
        filterCourse.appendChild(opt);
    });
    filterCourse.value = current;
}

function courseTag(course) {
    return course
        ? `<span class="badge">${course}</span>`
        : `<span class="badge">—</span>`;
}
function priorityBadge(p) {
    const klass = p === "High" ? "high" : p === "Low" ? "low" : "medium";
    return `<span class="badge ${klass}">${p}</span>`;
}
function dueBadges(a) {
    let b = "";
    if (isOverdue(a)) b += ` <span class="badge overdue">Overdue</span>`;
    else if (isDueSoon(a)) b += ` <span class="badge soon">Due soon</span>`;
    return b;
}
function statusPill(s) {
    return `<span class="status-pill ${s}">${
        s === "todo" ? "To-do" : s === "doing" ? "Doing" : "Done"
    }</span>`;
}
function reminderLabel(a) {
    if (a.remindAheadMinutes < 0) return "None";
    const mins = a.remindAheadMinutes;
    if (mins === 0) return "At due";
    if (mins === 15) return "15m before";
    if (mins === 30) return "30m before";
    if (mins === 60) return "1h before";
    if (mins === 1440) return "1d before";
    return `${mins}m before`;
}
function dueLabel(a) {
    const ts = dueTimestamp(a);
    const d = new Date(ts);
    const datePart = d.toLocaleDateString([], {
        weekday: "short",
        month: "short",
        day: "numeric",
    });
    const timePart = a.dueTime
        ? " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "";
    return `${datePart}${timePart}${dueBadges(a)}`;
}

function matchesFilters(a) {
    const f = state.filters;
    if (f.search) {
        const needle = f.search.toLowerCase();
        const hay = `${a.title} ${a.notes}`.toLowerCase();
        if (!hay.includes(needle)) return false;
    }
    if (f.course && a.course !== f.course) return false;
    if (f.priority && a.priority !== f.priority) return false;
    if (f.status && a.status !== f.status) return false;
    if (f.hideDone && a.status === "done") return false;
    return true;
}

function sortItems(items) {
    const s = state.filters.sort;
    const byDue = (x, y) => dueTimestamp(x) - dueTimestamp(y);
    const prioRank = (p) => ({ High: 3, Medium: 2, Low: 1 }[p] || 0);

    return items.sort((a, b) => {
        switch (s) {
            case "priorityDesc":
                return (
                    prioRank(b.priority) - prioRank(a.priority) || byDue(a, b)
                );
            case "courseAsc":
                return (
                    (a.course || "").localeCompare(b.course || "") ||
                    byDue(a, b)
                );
            case "titleAsc":
                return a.title.localeCompare(b.title) || byDue(a, b);
            case "statusAsc":
                return a.status.localeCompare(b.status) || byDue(a, b);
            case "dueAsc":
            default:
                return byDue(a, b) || a.title.localeCompare(b.title);
        }
    });
}

function renderList() {
    const filtered = sortItems(state.items.filter(matchesFilters));
    rowsTbody.innerHTML = "";

    if (!filtered.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 8;
        td.textContent = "No assignments match the filters.";
        tr.appendChild(td);
        rowsTbody.appendChild(tr);
        renderKPIs();
        hydrateCourseFilter();
        return;
    }

    for (const a of filtered) {
        const tr = document.createElement("tr");
        tr.dataset.id = a.id;

        tr.innerHTML = `
      <td>
        <div class="row-title">
          <div>${a.title || "Untitled"}</div>
          ${a.notes ? `<small>${a.notes}</small>` : ""}
        </div>
      </td>
      <td>${
          a.course
              ? `<span class="badge">${a.course}</span>`
              : '<span class="badge">—</span>'
      }</td>
      <td>${dueLabel(a)}</td>
      <td>${priorityBadge(a.priority)}</td>
      <td>${a.estimateHours ? `${a.estimateHours}h` : "—"}</td>
      <td style="white-space: nowrap;">${statusPill(a.status)}</td>
      <td>${reminderLabel(a)}</td>
      <td>
        <div class="actions-inline">
          <button class="row-btn" data-action="toggle-done" style="white-space: nowrap;">${
              a.status === "done" ? "↩︎ Undo" : "✔︎ Done"
          }</button>
          <button class="row-btn" data-action="ics">.ics</button>
          <button class="row-btn" data-action="edit">Edit</button>
          <button class="row-btn" data-action="delete">Delete</button>
        </div>
      </td>
    `;

        // Row click -> edit (ignore button clicks)
        tr.addEventListener("click", (ev) => {
            if (ev.target.closest("button")) return;
            openEdit(a.id);
        });

        tr.querySelectorAll("button").forEach((btn) => {
            btn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const action = btn.dataset.action;
                if (action === "edit") openEdit(a.id);
                if (action === "delete") confirmDelete(a.id);
                if (action === "toggle-done") toggleDone(a.id);
                if (action === "ics") exportICS(a.id);
            });
        });

        rowsTbody.appendChild(tr);
    }

    renderKPIs();
    hydrateCourseFilter();
}

// ---------- CRUD ----------
function addFromForm() {
    const title = titleInput.value.trim();
    const dueDate = dueDateInput.value;
    if (!title || !dueDate) {
        toast("Please fill Title and Due Date.", true);
        return;
    }

    const assignment = /** @type {Assignment} */ ({
        id: uid("asg"),
        title,
        course: courseInput.value.trim(),
        dueDate,
        dueTime: dueTimeInput.value,
        priority: priorityInput.value,
        estimateHours: Number(estimateInput.value) || 0,
        status: statusInput.value,
        notes: notesInput.value.trim(),
        remindAheadMinutes: Number(reminderAheadInput.value),
        notifiedAt: null,
        scheduledAt: null,
        createdAt: nowTs(),
        updatedAt: nowTs(),
    });

    state.items.push(assignment);
    saveState();
    scheduleReminder(assignment);
    renderList();
    toast("Added assignment.");

    resetCreateForm(); // keep UX clean
}

function resetCreateForm() {
    createForm.reset();
    priorityInput.value = "Medium";
    estimateInput.value = "1";
    reminderAheadInput.value = "30";
    statusInput.value = "todo";
}
function isFormDirty() {
    if (titleInput.value.trim()) return true;
    if (courseInput.value.trim()) return true;
    if (dueDateInput.value) return true;
    if (dueTimeInput.value) return true;
    if (notesInput.value.trim()) return true;
    if (priorityInput.value !== "Medium") return true;
    if (estimateInput.value !== "1") return true;
    if (reminderAheadInput.value !== "30") return true;
    if (statusInput.value !== "todo") return true;
    return false;
}

function toggleDone(id) {
    const a = byId(id);
    if (!a) return;
    if (a.status === "done") {
        a.status = "todo";
    } else {
        a.status = "done";
        cancelTimerFor(id);
    }
    a.updatedAt = nowTs();
    saveState();
    renderList();
}

function confirmDelete(id) {
    const a = byId(id);
    if (!a) return;
    const d = new Date(dueTimestamp(a));
    const label = `${a.title} — ${d.toLocaleDateString()}${
        a.dueTime ? " " + a.dueTime : ""
    }`;
    const ok = confirm(
        `Delete this assignment?\n\n${label}\n\nThis cannot be undone.`
    );
    if (!ok) return;
    cancelTimerFor(id);
    state.items = state.items.filter((x) => x.id !== id);
    saveState();
    renderList();
    toast("Deleted.");
}

function clearAll() {
    if (!state.items.length) {
        toast("Nothing to clear.");
        return;
    }
    const ok = confirm(
        `Clear all ${state.items.length} assignments? This cannot be undone.`
    );
    if (!ok) return;
    state.items.forEach((a) => cancelTimerFor(a.id));
    state.items = [];
    saveState();
    renderList();
    toast("All cleared.");
}

// ---------- Edit dialog ----------
function openEdit(id) {
    const a = byId(id);
    if (!a) return;
    editId.value = a.id;
    editTitle.value = a.title;
    editCourse.value = a.course || "";
    editDate.value = a.dueDate;
    editTime.value = a.dueTime || "";
    editPriority.value = a.priority;
    editEstimate.value = String(a.estimateHours || 0);
    editStatus.value = a.status;
    editNotes.value = a.notes || "";
    editReminder.value = String(a.remindAheadMinutes);
    editDialog.showModal();
}

saveBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    const id = editId.value;
    const a = byId(id);
    if (!a) {
        editDialog.close();
        return;
    }

    a.title = editTitle.value.trim() || a.title;
    a.course = editCourse.value.trim();
    a.dueDate = editDate.value || a.dueDate;
    a.dueTime = editTime.value;
    a.priority = editPriority.value;
    a.estimateHours = Number(editEstimate.value) || 0;
    a.status = editStatus.value;
    a.notes = editNotes.value.trim();
    a.remindAheadMinutes = Number(editReminder.value);
    a.updatedAt = nowTs();

    // reschedule if needed
    if (a.status === "done") cancelTimerFor(a.id);
    else scheduleReminder(a);

    saveState();
    renderList();
    editDialog.close();
    toast("Updated.");
});

deleteBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    const id = editId.value;
    const a = byId(id);
    if (!a) {
        editDialog.close();
        return;
    }

    const d = new Date(dueTimestamp(a));
    const summary = `${a.title} — ${d.toLocaleDateString()}${
        a.dueTime ? " " + a.dueTime : ""
    }`;
    const ok = confirm(
        `Delete this assignment?\n\n${summary}\n\nThis cannot be undone.`
    );
    if (!ok) return;

    editDialog.close();
    confirmDelete(id);
});

// ---------- ICS Export ----------
function exportICS(id) {
    const a = byId(id);
    if (!a) return;
    const dtStart = new Date(dueTimestamp(a));
    const dtEnd = new Date(
        dtStart.getTime() +
            Math.max(30, Math.round((a.estimateHours || 1) * 60)) * 60000
    );
    const fmt = (d) =>
        d
            .toISOString()
            .replace(/[-:]/g, "")
            .replace(/\.\d{3}Z$/, "Z");

    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Assignment Planner//EN
BEGIN:VEVENT
UID:${a.id}@assignment-planner
DTSTAMP:${fmt(new Date())}
DTSTART:${fmt(dtStart)}
DTEND:${fmt(dtEnd)}
SUMMARY:${a.title.replace(/\n/g, " ")}
DESCRIPTION:${(a.course ? a.course + " — " : "") + (a.notes || "")}
PRIORITY:${a.priority === "High" ? 1 : a.priority === "Medium" ? 5 : 9}
END:VEVENT
END:VCALENDAR`;

    const blob = new Blob([ics], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `assignment_${a.title
        .replace(/[^a-z0-9]+/gi, "-")
        .toLowerCase()}.ics`;
    link.click();
    URL.revokeObjectURL(url);
}

// ---------- Events ----------
createForm.addEventListener("submit", (e) => {
    e.preventDefault();
    addFromForm();
});

resetFormBtn.addEventListener("click", () => {
    if (isFormDirty()) {
        const ok = confirm(
            "Reset the form? This will clear all entered values."
        );
        if (!ok) return;
    }
    resetCreateForm();
    toast("Form reset.");
});

searchInput.addEventListener("input", () => {
    state.filters.search = searchInput.value.trim();
    saveState();
    renderList();
});
filterCourse.addEventListener("change", () => {
    state.filters.course = filterCourse.value;
    saveState();
    renderList();
});
filterPriority.addEventListener("change", () => {
    state.filters.priority = filterPriority.value;
    saveState();
    renderList();
});
filterStatus.addEventListener("change", () => {
    state.filters.status = filterStatus.value;
    saveState();
    renderList();
});
hideDoneCheck.addEventListener("change", () => {
    state.filters.hideDone = hideDoneCheck.checked;
    saveState();
    renderList();
});
sortSelect.addEventListener("change", () => {
    state.filters.sort = sortSelect.value;
    saveState();
    renderList();
});

clearFiltersBtn.addEventListener("click", () => {
    state.filters = {
        search: "",
        course: "",
        priority: "",
        status: "",
        hideDone: false,
        sort: "dueAsc",
    };
    searchInput.value = "";
    filterCourse.value = "";
    filterPriority.value = "";
    filterStatus.value = "";
    hideDoneCheck.checked = false;
    sortSelect.value = "dueAsc";
    saveState();
    renderList();
});

notifyPermissionBtn.addEventListener("click", async () => {
    if (!("Notification" in window)) return;
    const res = await Notification.requestPermission();
    updateNotifyButton();
    if (res === "granted") {
        rescheduleAll();
        toast("Reminders enabled.");
    }
});

exportCsvBtn.addEventListener("click", () => {
    const csv = toCSV(state.items);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "assignments.csv";
    a.click();
    URL.revokeObjectURL(url);
});

importCsvInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
        const text = await file.text();
        const items = parseCSV(text);
        if (!items.length) {
            toast("No rows found in CSV.", true);
            return;
        }
        state.items.push(...items);
        saveState();
        renderList();
        rescheduleAll();
        toast(`Imported ${items.length} item(s).`);
    } catch {
        toast("Failed to import CSV.", true);
    } finally {
        importCsvInput.value = "";
    }
});

printBtn.addEventListener("click", () => window.print());
clearAllBtn.addEventListener("click", clearAll);

// ---------- Boot ----------
(function init() {
    loadState();
    updateNotifyButton();

    // reflect saved filters
    searchInput.value = state.filters.search;
    filterCourse.value = state.filters.course;
    filterPriority.value = state.filters.priority;
    filterStatus.value = state.filters.status;
    hideDoneCheck.checked = state.filters.hideDone;
    sortSelect.value = state.filters.sort;

    renderList();
    rescheduleAll();
})();
