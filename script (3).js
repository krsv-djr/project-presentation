// ===== Cấu hình chung =====
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const LEVELS = ["A1", "A2", "B1", "B2", "C1"];
const $ = (id) => document.getElementById(id);

// API key và tên model lưu trong localStorage (KHÔNG ghi cứng vào code)
const store = {
  get key() { return localStorage.getItem("aiec_key") || ""; },
  get model() { return localStorage.getItem("aiec_model") || "gemini-flash-latest"; },
};

// Tạo phần tử bằng textContent để nội dung từ AI không chèn được HTML
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function notify(msg) {
  $("notice").textContent = msg;
  $("notice").hidden = !msg;
}

// ===== System prompt =====
const chatPrompt = (level, topic) => `Bạn là "AI English Coach", gia sư tiếng Anh thân thiện cho người Việt Nam.
Trình độ người học: ${level}. Chủ đề: ${topic}.

Mỗi lượt, hãy:
1. Phân tích câu tiếng Anh của người học: lỗi ngữ pháp, chính tả, dùng từ chưa tự nhiên.
2. Trả lời tiếp hội thoại bằng tiếng Anh đơn giản, đúng trình độ ${level}, tối đa 3 câu, kết thúc bằng một câu hỏi.

CHỈ trả về JSON hợp lệ, không thêm chữ nào khác:
{
  "reply": "câu trả lời tiếng Anh",
  "correction": {
    "has_error": true,
    "original": "câu gốc của người học",
    "corrected": "câu đã sửa",
    "explanation_vi": "giải thích lỗi bằng tiếng Việt, ngắn gọn, dễ hiểu",
    "vocab_tips": ["cách nói tự nhiên hơn 1", "cách nói tự nhiên hơn 2"]
  }
}
Nếu câu đúng, đặt has_error = false và để explanation_vi là lời khen ngắn.
Nếu người học viết tiếng Việt, hãy dịch sang tiếng Anh và khuyến khích họ thử lại.`;

const testPrompt = (n, level) => `Hãy tạo bài kiểm tra tiếng Anh ${n} câu trắc nghiệm, mức ${level} theo CEFR.
Phân bổ: ngữ pháp, từ vựng, đọc hiểu ngắn. Câu hỏi không lặp, độ khó tăng dần.
Mỗi câu có 4 đáp án, chỉ 1 đáp án đúng, các đáp án sai phải hợp lý.

CHỈ trả về JSON hợp lệ:
{
  "questions": [
    {
      "skill": "grammar | vocabulary | reading",
      "question": "...",
      "options": ["...", "...", "...", "..."],
      "answer_index": 0,
      "explanation_vi": "vì sao đáp án này đúng, giải thích bằng tiếng Việt"
    }
  ]
}`;

// ===== Gọi Gemini API =====
async function callAI(system, contents, timeoutMs) {
  if (!store.key) {
    openSettings();
    throw new Error("Hãy dán API key trong Cài đặt trước khi dùng.");
  }
  let res;
  const ctrl = new AbortController(); // dùng để huỷ nếu AI không phản hồi
  const timer = setTimeout(() => ctrl.abort(), timeoutMs); // thời gian chờ tối đa (mili giây)
  try {
    res = await fetch(`${API_BASE}${store.model}:generateContent`, {
      signal: ctrl.signal,
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": store.key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { responseMimeType: "application/json", temperature: 0.7 },
      }),
    });
  } catch (err) {
    throw new Error(err.name === "AbortError"
      ? `AI phản hồi quá lâu (hơn ${timeoutMs / 1000} giây). Hãy thử lại sau ít phút.`
      : "Không kết nối được mạng. Kiểm tra internet rồi thử lại.");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const msgs = {
      400: "API key không hợp lệ hoặc yêu cầu sai. Kiểm tra lại key trong Cài đặt.",
      403: "API key sai hoặc chưa được cấp quyền.",
      404: "Không tìm thấy model. Hãy đổi tên model trong Cài đặt.",
      429: "Vượt giới hạn miễn phí. Đợi khoảng 1 phút rồi thử lại.",
    };
    throw new Error(msgs[res.status] || `API báo lỗi (mã ${res.status}). Thử lại sau.`);
  }
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim()); // bỏ rào ``` nếu AI lỡ thêm
  } catch {
    throw new Error("AI trả về dữ liệu sai định dạng. Hãy thử lại.");
  }
}

// ===== Chuyển tab =====
document.querySelectorAll(".tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    $("view-chat").hidden = btn.dataset.view !== "chat";
    $("view-test").hidden = btn.dataset.view !== "test";
    notify("");
  })
);

// ===== Cài đặt =====
function openSettings() {
  $("apiKey").value = store.key;
  $("modelName").value = store.model;
  $("settings").showModal();
}
$("openSettings").addEventListener("click", openSettings);
$("saveSettings").addEventListener("click", () => {
  localStorage.setItem("aiec_key", $("apiKey").value.trim());
  localStorage.setItem("aiec_model", $("modelName").value.trim() || "gemini-flash-latest");
  $("settings").close();
  notify("");
});

// ===== Tính năng 1 + 2: hội thoại và sửa lỗi =====
const history = []; // lịch sử gửi cho AI

function resetChat() {
  history.length = 0;
  $("messages").replaceChildren(
    el("p", "empty", 'Viết một câu tiếng Anh để bắt đầu, ví dụ: "Hello, I want practice English."')
  );
}

function addBubble(who, text) {
  const box = $("messages");
  box.querySelector(".empty")?.remove();
  const b = el("div", `bubble ${who}`, text);
  box.append(b);
  box.scrollTop = box.scrollHeight;
  return b;
}

// Thẻ "Sửa lỗi"
function buildCorrection(c) {
  const card = el("div", "card");
  if (!c.has_error) {
    card.classList.add("ok");
    card.append(el("p", "", "✓ " + (c.explanation_vi || "Câu của bạn đúng rồi!")));
    return card;
  }
  card.append(el("p", "bad", c.original || ""));
  card.append(el("p", "good", c.corrected || ""));
  card.append(el("p", "", c.explanation_vi || ""));
  if (Array.isArray(c.vocab_tips) && c.vocab_tips.length) {
    card.append(el("p", "", "Nói tự nhiên hơn: " + c.vocab_tips.slice(0, 2).join(" / ")));
  }
  return card;
}

function setChatBusy(busy) {
  $("sendBtn").disabled = busy;
  $("chatInput").disabled = busy;
}

$("chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text) return notify("Hãy nhập câu tiếng Anh trước khi gửi.");
  notify("");
  addBubble("user", text);
  $("chatInput").value = "";
  const loading = addBubble("ai", "AI đang trả lời…");
  loading.classList.add("loading");
  setChatBusy(true);
  try {
    const system = chatPrompt($("chatLevel").value, $("topic").value);
    const userMsg = { role: "user", parts: [{ text }] };
    const data = await callAI(system, [...history, userMsg], 15000); // hội thoại: 15 giây
    if (typeof data.reply !== "string" || !data.correction) {
      throw new Error("AI trả về dữ liệu sai định dạng. Hãy thử lại.");
    }
    history.push(userMsg, { role: "model", parts: [{ text: data.reply }] });
    loading.before(buildCorrection(data.correction)); // thẻ sửa lỗi nằm ngay dưới tin nhắn của bạn
    loading.textContent = data.reply;
    loading.classList.remove("loading");
  } catch (err) {
    loading.remove();
    notify(err.message);
  } finally {
    setChatBusy(false);
    $("chatInput").focus();
    $("messages").scrollTop = $("messages").scrollHeight;
  }
});

// Đổi chủ đề hoặc trình độ thì bắt đầu hội thoại mới
$("topic").addEventListener("change", resetChat);
$("chatLevel").addEventListener("change", resetChat);

// ===== Tính năng 3: bài kiểm tra =====
let questions = [];

// Ước lượng trình độ từ điểm: >=90% lên 1 bậc, 70–89% giữ nguyên, 40–69% xuống 1, dưới 40% xuống 2
function estimateLevel(level, ratio) {
  const i = LEVELS.indexOf(level);
  const shift = ratio >= 0.9 ? 1 : ratio >= 0.7 ? 0 : ratio >= 0.4 ? -1 : -2;
  return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, i + shift))];
}

function validQuestions(list) {
  return Array.isArray(list) && list.length > 0 && list.every((q) =>
    q.question && Array.isArray(q.options) && q.options.length === 4 &&
    Number.isInteger(q.answer_index) && q.answer_index >= 0 && q.answer_index < 4);
}

function renderTest(level) {
  const form = el("form");
  questions.forEach((q, i) => {
    const fs = el("fieldset");
    fs.append(el("legend", "", `${i + 1}. ${q.question}`));
    q.options.forEach((opt, j) => {
      const label = el("label", "opt");
      const radio = el("input");
      radio.type = "radio"; radio.name = "q" + i; radio.value = j;
      label.append(radio, el("span", "", opt));
      fs.append(label);
    });
    form.append(fs);
  });
  const submit = el("button", "", "Nộp bài");
  submit.type = "submit";
  form.append(submit);
  form.addEventListener("submit", (e) => { e.preventDefault(); gradeTest(form, level, submit); });
  $("testArea").replaceChildren(form);
}

function gradeTest(form, level, submitBtn) {
  let score = 0;
  form.querySelectorAll("fieldset").forEach((fs, i) => {
    const q = questions[i];
    const chosen = fs.querySelector("input:checked");
    const right = chosen && Number(chosen.value) === q.answer_index;
    if (right) score++;
    fs.classList.add(right ? "right" : "wrong");
    fs.querySelectorAll("input").forEach((r) => (r.disabled = true));
    fs.append(el("p", "explain",
      `${right ? "Đúng." : "Chưa đúng."} Đáp án: ${q.options[q.answer_index]}. ${q.explanation_vi || ""}`));
  });
  const res = el("div", "result");
  res.append(el("strong", "", `Điểm: ${score}/${questions.length}`));
  res.append(el("p", "", `Trình độ ước lượng: ${estimateLevel(level, score / questions.length)} (chỉ mang tính tham khảo)`));
  form.prepend(res);
  submitBtn.remove();
  res.scrollIntoView({ behavior: "smooth", block: "start" });
}

$("genTest").addEventListener("click", async () => {
  const level = $("testLevel").value;
  notify("");
  $("genTest").disabled = true;
  $("testArea").replaceChildren(el("p", "empty", "Đang tạo đề, chờ vài giây…"));
  try {
    const data = await callAI(testPrompt(10, level), [{ role: "user", parts: [{ text: `Tạo đề mức ${level}.` }] }], 25000); // tạo đề: 25 giây
    if (!validQuestions(data.questions)) throw new Error("AI trả về dữ liệu sai định dạng. Hãy thử lại.");
    questions = data.questions;
    renderTest(level);
  } catch (err) {
    $("testArea").replaceChildren();
    notify(err.message);
  } finally {
    $("genTest").disabled = false;
  }
});

// ===== Khởi động =====
resetChat();
if (!store.key) openSettings(); // lần đầu chưa có key thì mở Cài đặt
