/**
 * The mock demo-request form served at GET /.
 *
 * Deliberately a single self-contained string with NO server-side
 * interpolation: nothing from the environment or from a request can reach the
 * browser through this page, so no secret can leak into the HTML. It posts
 * same-origin to /api/lead, so no CORS configuration is required.
 */
export const DEMO_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Book a Demo with Lyzr</title>
<style>
  :root {
    --bg: #f6f7f9;
    --card: #ffffff;
    --ink: #0f1729;
    --muted: #5b6577;
    --line: #e3e7ee;
    --brand: #1f4bd8;
    --brand-ink: #ffffff;
    --danger: #b42318;
    --ok: #067647;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex;
    justify-content: center;
    padding: 40px 20px 64px;
  }
  main { width: 100%; max-width: 560px; }
  header { text-align: center; margin-bottom: 24px; }
  .mark {
    display: inline-block; font-weight: 700; letter-spacing: -0.02em;
    font-size: 20px; color: var(--brand); margin-bottom: 14px;
  }
  h1 { font-size: 27px; line-height: 1.25; letter-spacing: -0.02em; margin: 0 0 8px; }
  .sub { color: var(--muted); margin: 0; font-size: 15px; }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 28px;
    box-shadow: 0 1px 2px rgba(16,24,40,.04), 0 8px 24px rgba(16,24,40,.05);
  }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .field { margin-bottom: 16px; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  .req { color: var(--brand); }
  input, textarea, select {
    width: 100%; padding: 10px 12px; font: inherit; color: inherit;
    background: #fff; border: 1px solid var(--line); border-radius: 8px;
    transition: border-color .15s, box-shadow .15s;
  }
  input:focus, textarea:focus, select:focus {
    outline: none; border-color: var(--brand);
    box-shadow: 0 0 0 3px rgba(31,75,216,.13);
  }
  textarea { min-height: 96px; resize: vertical; }
  .hint { color: var(--muted); font-size: 12px; margin-top: 6px; }
  button {
    width: 100%; margin-top: 8px; padding: 12px 16px;
    font: inherit; font-weight: 600; color: var(--brand-ink);
    background: var(--brand); border: 0; border-radius: 8px; cursor: pointer;
    transition: opacity .15s, transform .05s;
  }
  button:hover:not(:disabled) { opacity: .92; }
  button:active:not(:disabled) { transform: translateY(1px); }
  button:disabled { opacity: .6; cursor: not-allowed; }
  .status { margin-top: 14px; font-size: 14px; text-align: center; min-height: 20px; }
  .status.error { color: var(--danger); }
  .done { text-align: center; padding: 20px 4px; }
  .done .tick {
    width: 44px; height: 44px; border-radius: 50%; margin: 0 auto 14px;
    background: #e7f6ee; color: var(--ok);
    display: flex; align-items: center; justify-content: center; font-size: 22px;
  }
  .done h2 { font-size: 18px; margin: 0 0 8px; }
  .done p { color: var(--muted); margin: 0; }
  footer { text-align: center; color: var(--muted); font-size: 12px; margin-top: 20px; }
  @media (max-width: 520px) {
    body { padding: 24px 16px 40px; }
    .card { padding: 20px; }
    .row { grid-template-columns: 1fr; gap: 0; }
    h1 { font-size: 23px; }
  }
</style>
</head>
<body>
<main>
  <header>
    <div class="mark">Lyzr</div>
    <h1>Book a Demo with Lyzr</h1>
    <p class="sub">Tell us what you're building and we'll be in touch.</p>
  </header>

  <div class="card">
    <form id="lead-form">
      <div class="row">
        <div class="field">
          <label for="first_name">First name <span class="req">*</span></label>
          <input id="first_name" name="first_name" autocomplete="given-name" required />
        </div>
        <div class="field">
          <label for="last_name">Last name</label>
          <input id="last_name" name="last_name" autocomplete="family-name" />
        </div>
      </div>

      <div class="field">
        <label for="email">Work email <span class="req">*</span></label>
        <input id="email" name="email" type="email" autocomplete="email" required />
      </div>

      <div class="field">
        <label for="phone">Phone number <span class="req">*</span></label>
        <input id="phone" name="phone" type="tel" placeholder="+919876543210" autocomplete="tel" required />
        <div class="hint">Include your country code.</div>
      </div>

      <div class="field">
        <label for="company">Company <span class="req">*</span></label>
        <input id="company" name="company" autocomplete="organization" required />
      </div>

      <div class="field">
        <label for="use_case">What are you looking to build? <span class="req">*</span></label>
        <textarea id="use_case" name="use_case" required
          placeholder="e.g. An AI SDR that qualifies inbound leads"></textarea>
      </div>

      <div class="field">
        <label for="timezone">Timezone</label>
        <input id="timezone" name="timezone" />
      </div>

      <button id="submit" type="submit">Talk to Lyzr</button>
      <div class="status" id="status" role="status" aria-live="polite"></div>
    </form>

    <div class="done" id="done" hidden>
      <div class="tick" aria-hidden="true">&#10003;</div>
      <h2>Thanks &mdash; we've got your details.</h2>
      <p>Someone from Lyzr will follow up shortly.</p>
    </div>
  </div>

  <footer>Your details are used only to arrange this demo.</footer>
</main>

<script>
(function () {
  var form = document.getElementById("lead-form");
  var button = document.getElementById("submit");
  var status = document.getElementById("status");
  var done = document.getElementById("done");
  var tzField = document.getElementById("timezone");

  try {
    tzField.value = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata";
  } catch (e) {
    tzField.value = "Asia/Kolkata";
  }

  // Guards against a double submit racing past the disabled button.
  var submitting = false;

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (submitting) return;

    var payload = {
      first_name: form.first_name.value.trim(),
      last_name: form.last_name.value.trim(),
      email: form.email.value.trim(),
      phone: form.phone.value.trim(),
      company: form.company.value.trim(),
      use_case: form.use_case.value.trim(),
      timezone: tzField.value.trim()
    };

    submitting = true;
    button.disabled = true;
    button.textContent = "Submitting...";
    status.textContent = "";
    status.className = "status";

    fetch("/api/lead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        return response.json().then(
          function (body) { return { ok: response.ok, body: body }; },
          function () { return { ok: false, body: {} }; }
        );
      })
      .then(function (result) {
        if (!result.ok || !result.body || result.body.success !== true) {
          throw new Error("submission failed");
        }
        form.hidden = true;
        done.hidden = false;
      })
      .catch(function () {
        submitting = false;
        button.disabled = false;
        button.textContent = "Talk to Lyzr";
        status.textContent = "Something went wrong. Please try again.";
        status.className = "status error";
      });
  });
})();
</script>
</body>
</html>
`;
