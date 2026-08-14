import { useState, type FormEvent } from "react";
import { ApiRequestError, login } from "../api.js";

export function LoginScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(password);
      onAuthenticated();
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 429) {
        setError("尝试次数过多，请稍后再试。");
      } else {
        setError("密码不正确。");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark" aria-hidden="true">✦</div>
        <h1>Asterism</h1>
        <p>输入队伍密码以打开协作白板。</p>
        <label htmlFor="password">队伍密码</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error && <div className="form-error" role="alert">{error}</div>}
        <button type="submit" disabled={submitting || !password}>
          {submitting ? "验证中…" : "进入白板"}
        </button>
      </form>
    </main>
  );
}

