import { useState, useEffect, useRef, type ReactNode } from 'react';
import { useUIStore } from '@bench/stores/ui-store';
import { getSettings, putSettings, DEFAULT_RISK_WEIGHTS, DEFAULT_CATEGORIES, type RiskWeights } from './api';

type Tab = 'general' | 'auth' | 'editor' | 'scoring';

const s = { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'general', label: 'General', icon: <svg {...s}><circle cx="8" cy="8" r="2.5" /><path d="M6.8 1.5h2.4l.3 1.8.9.4 1.6-.9 1.7 1.7-.9 1.6.4.9 1.8.3v2.4l-1.8.3-.4.9.9 1.6-1.7 1.7-1.6-.9-.9.4-.3 1.8H6.8l-.3-1.8-.9-.4-1.6.9-1.7-1.7.9-1.6-.4-.9-1.8-.3V6.8l1.8-.3.4-.9-.9-1.6L4 2.3l1.6.9.9-.4z" /></svg> },
  { id: 'auth', label: 'Authentication', icon: <svg {...s}><rect x="3" y="7" width="10" height="7" rx="1" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /></svg> },
  { id: 'editor', label: 'Editor', icon: <svg {...s}><polyline points="4 4 1 8 4 12" /><polyline points="12 4 15 8 12 12" /><line x1="10" y1="2" x2="6" y2="14" /></svg> },
  { id: 'scoring', label: 'Scoring', icon: <svg {...s}><path d="M3 13V7M7 13V3M11 13V9M15 13V5" /></svg> },
];

// ── Settings shape (all keys stored as JSON strings in the backend) ──

interface GeneralSettings {
  theme: 'dark' | 'light';
  displayName: string;
  avatarUrl: string;
}

interface AuthMethods {
  password: boolean;
  social: boolean;
  sso: boolean;
}

interface SamlConfig {
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertificate: string;
  spEntityId: string;
  acsUrl: string;
  allowIdpInitiated: boolean;
  nameIdFormat: string;
}

interface UserEntry {
  email: string;
  role: 'admin' | 'reviewer' | 'viewer';
  status: 'active' | 'invited' | 'disabled';
  lastLogin?: string;
}

interface ServiceAccount {
  name: string;
  prefix: string;
  role: 'admin' | 'reviewer' | 'viewer';
  createdAt: string;
  lastUsed?: string;
}

interface AuthSettings {
  methods: AuthMethods;
  saml: SamlConfig;
  users: UserEntry[];
  serviceAccounts: ServiceAccount[];
}

interface EditorSettings {
  fontSize: number;
  defaultRepoPath: string;
  tabSize: number;
  wordWrap: boolean;
}

const DEFAULT_GENERAL: GeneralSettings = {
  theme: 'dark',
  displayName: '',
  avatarUrl: '',
};

const DEFAULT_AUTH: AuthSettings = {
  methods: { password: true, social: false, sso: false },
  saml: {
    idpEntityId: '',
    idpSsoUrl: '',
    idpCertificate: '',
    spEntityId: '',
    acsUrl: '',
    allowIdpInitiated: false,
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  },
  users: [],
  serviceAccounts: [],
};

const DEFAULT_EDITOR: EditorSettings = {
  fontSize: 13,
  defaultRepoPath: '',
  tabSize: 4,
  wordWrap: false,
};

function useSaveAction() {
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const save = async (key: string, value: unknown) => {
    setSaved(false);
    setError('');
    try {
      await putSettings({ [key]: JSON.stringify(value) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const feedback = (
    <>
      {saved && <span className="settings-feedback settings-feedback-ok">Saved</span>}
      {error && <span className="settings-feedback settings-feedback-err">{error}</span>}
    </>
  );

  return { save, feedback };
}

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('general');

  // ── All settings state ──
  const [general, setGeneral] = useState<GeneralSettings>(DEFAULT_GENERAL);
  const [auth, setAuth] = useState<AuthSettings>(DEFAULT_AUTH);
  const [editor, setEditor] = useState<EditorSettings>(DEFAULT_EDITOR);
  const [weights, setWeights] = useState<RiskWeights>(DEFAULT_RISK_WEIGHTS);
  const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES);

  useEffect(() => {
    getSettings()
      .then((s) => {
        if (s.general) try { setGeneral({ ...DEFAULT_GENERAL, ...JSON.parse(s.general) }); } catch {}
        if (s.auth) try { setAuth({ ...DEFAULT_AUTH, ...JSON.parse(s.auth) }); } catch {}
        if (s.editor) try { setEditor({ ...DEFAULT_EDITOR, ...JSON.parse(s.editor) }); } catch {}
        if (s.riskWeights) try { setWeights({ ...DEFAULT_RISK_WEIGHTS, ...JSON.parse(s.riskWeights) }); } catch {}
        if (s.categories) try {
          const parsed = JSON.parse(s.categories);
          if (Array.isArray(parsed) && parsed.length > 0) setCategories(parsed);
        } catch {}
      })
      .catch(() => {});
  }, []);

  return (
    <div className="settings-page">
      <div className="settings-content">
        <h2 className="overview-section-title settings-title">Settings</h2>

        <div className="tab-bar tab-bar--transparent">
          <div className="tab-bar-tabs">
            {TABS.map(({ id, label, icon }) => (
              <button
                key={id}
                className={`tab-bar-tab${tab === id ? ' tab-bar-tab-active' : ''}`}
                onClick={() => setTab(id)}
              >
                {icon}{label}
              </button>
            ))}
          </div>
        </div>

        {tab === 'general' && (
          <GeneralTab settings={general} onChange={setGeneral} />
        )}
        {tab === 'auth' && (
          <AuthTab settings={auth} onChange={setAuth} />
        )}
        {tab === 'editor' && (
          <EditorTab settings={editor} onChange={setEditor} />
        )}
        {tab === 'scoring' && (
          <ScoringTab
            weights={weights} onWeightsChange={setWeights}
            categories={categories} onCategoriesChange={setCategories}
          />
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   General Tab
   ════════════════════════════════════════════════════════════ */

function GeneralTab({ settings, onChange }: { settings: GeneralSettings; onChange: (s: GeneralSettings) => void }) {
  const theme = useUIStore((st) => st.theme);
  const toggleTheme = useUIStore((st) => st.toggleTheme);
  const { save, feedback } = useSaveAction();
  const fileRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    save('general', settings);
  };

  return (
    <>
      {/* Theme */}
      <form className="settings-section" onSubmit={handleSubmit}>
        <div className="settings-section-header">
          <h3 className="settings-section-title">Theme</h3>
          <p className="settings-section-description">Choose light or dark appearance for the interface. Applies straight away, here and in the rail.</p>
        </div>

        {/* The same setting as the rail's theme button (bench's UI store), not a separate saved value. */}
        <div className="view-mode-toggle settings-toggle-group" role="group" aria-label="Theme">
          {(['dark', 'light'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`view-mode-btn settings-theme-option${theme === t ? ' view-mode-btn-active' : ''}`}
              aria-pressed={theme === t}
              onClick={() => { if (theme !== t) toggleTheme(); }}
            >
              <span className={`settings-theme-preview settings-theme-preview-${t}`} />
              {t === 'dark' ? 'Dark' : 'Light'}
            </button>
          ))}
        </div>

        {/* User Profile */}
        <div className="settings-section-header" style={{ marginTop: 8 }}>
          <h3 className="settings-section-title">User Profile</h3>
          <p className="settings-section-description">Display name and avatar shown on findings and comments.</p>
        </div>

        <div className="settings-group">
          <div className="settings-field">
            <label className="settings-label">Display name</label>
            <input
              className="finding-edit-input settings-field-grow"
              value={settings.displayName}
              onChange={(e) => onChange({ ...settings, displayName: e.target.value })}
              placeholder="Your name"
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Avatar</label>
            <div className="settings-avatar-field">
              {settings.avatarUrl ? (
                <img className="settings-avatar-preview" src={settings.avatarUrl} alt="" />
              ) : (
                <span className="settings-avatar-placeholder" />
              )}
              <button type="button" className="baseline-action-btn baseline-action-btn-outline" onClick={() => fileRef.current?.click()}>
                Upload
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => onChange({ ...settings, avatarUrl: reader.result as string });
                  reader.readAsDataURL(file);
                }}
              />
              {settings.avatarUrl && (
                <button type="button" className="baseline-action-btn baseline-action-btn-outline" onClick={() => onChange({ ...settings, avatarUrl: '' })}>
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="settings-actions">
          <button className="baseline-action-btn baseline-action-btn-primary" type="submit">Save</button>
          {feedback}
        </div>
      </form>
    </>
  );
}

/* ════════════════════════════════════════════════════════════
   Authentication Tab
   ════════════════════════════════════════════════════════════ */

const ROLES = ['admin', 'reviewer', 'viewer'] as const;

function AuthTab({ settings, onChange }: { settings: AuthSettings; onChange: (s: AuthSettings) => void }) {
  const { save, feedback } = useSaveAction();
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'reviewer' | 'viewer'>('reviewer');
  const [newSaName, setNewSaName] = useState('');
  const [newSaRole, setNewSaRole] = useState<'admin' | 'reviewer' | 'viewer'>('reviewer');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    save('auth', settings);
  };

  const setMethod = (key: keyof AuthMethods, val: boolean) => {
    onChange({ ...settings, methods: { ...settings.methods, [key]: val } });
  };

  const setSaml = (patch: Partial<SamlConfig>) => {
    onChange({ ...settings, saml: { ...settings.saml, ...patch } });
  };

  // User management helpers
  const inviteUser = () => {
    const email = newEmail.trim().toLowerCase();
    if (!email || settings.users.some((u) => u.email === email)) return;
    onChange({ ...settings, users: [...settings.users, { email, role: newRole, status: 'invited' }] });
    setNewEmail('');
  };

  const updateUser = (idx: number, patch: Partial<UserEntry>) => {
    const users = [...settings.users];
    users[idx] = { ...users[idx], ...patch };
    onChange({ ...settings, users });
  };

  const removeUser = (idx: number) => {
    onChange({ ...settings, users: settings.users.filter((_, i) => i !== idx) });
  };

  // Service account helpers
  const createServiceAccount = () => {
    const name = newSaName.trim() || 'Untitled';
    const prefix = 'sa_' + Array.from(crypto.getRandomValues(new Uint8Array(12)))
      .map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    onChange({
      ...settings,
      serviceAccounts: [...settings.serviceAccounts, {
        name,
        prefix: prefix + '...',
        role: newSaRole,
        createdAt: new Date().toISOString(),
      }],
    });
    setNewSaName('');
  };

  const updateServiceAccount = (idx: number, patch: Partial<ServiceAccount>) => {
    const sa = [...settings.serviceAccounts];
    sa[idx] = { ...sa[idx], ...patch };
    onChange({ ...settings, serviceAccounts: sa });
  };

  const revokeServiceAccount = (idx: number) => {
    onChange({ ...settings, serviceAccounts: settings.serviceAccounts.filter((_, i) => i !== idx) });
  };

  return (
    <form className="settings-section" onSubmit={handleSubmit}>
      {/* ── Methods ── */}
      <div className="settings-section-header">
        <h3 className="settings-section-title">Methods</h3>
        <p className="settings-section-description">
          Choose which authentication methods users can sign in with. At least one method must remain enabled.
        </p>
      </div>

      <div className="settings-group">
        {([
          { key: 'password' as const, label: 'Password', desc: 'Email and password authentication' },
          { key: 'social' as const, label: 'Social login', desc: 'Google, GitHub, Microsoft via OAuth' },
          { key: 'sso' as const, label: 'SSO (SAML)', desc: 'Enterprise single sign-on' },
        ]).map(({ key, label, desc }) => {
          const enabled = settings.methods[key];
          const enabledCount = Object.values(settings.methods).filter(Boolean).length;
          const canDisable = enabledCount > 1 || !enabled;
          return (
            <div key={key} className="settings-auth-method-row">
              <div className="settings-auth-method-info">
                <span className="settings-auth-method-label">{label}</span>
                <span className="settings-auth-method-desc">
                  {desc}
                  {!canDisable && ' · required: at least one method must stay on'}
                </span>
              </div>
              <button
                type="button"
                className={`settings-switch${enabled ? ' settings-switch-on' : ''}`}
                onClick={() => canDisable && setMethod(key, !enabled)}
                role="switch"
                aria-checked={enabled}
                aria-label={label}
                aria-disabled={!canDisable}
                title={!canDisable ? 'At least one method must be enabled' : undefined}
                style={!canDisable ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
              >
                <span className="settings-switch-thumb" />
              </button>
            </div>
          );
        })}
      </div>

      {/* ── SAML Configuration ── */}
      <div className="settings-section-header" style={{ marginTop: 8 }}>
        <h3 className="settings-section-title">SAML Configuration</h3>
        <p className="settings-section-description">
          {settings.methods.sso
            ? 'Configure your identity provider for SAML 2.0 single sign-on.'
            : 'Enable SSO above to configure SAML.'}
        </p>
      </div>

      {settings.methods.sso ? (
        <div className="settings-group">
          <div className="settings-group-title">Identity Provider</div>
          <div className="settings-field">
            <label className="settings-label">IdP Entity ID</label>
            <input
              className="finding-edit-input settings-field-grow"
              value={settings.saml.idpEntityId}
              onChange={(e) => setSaml({ idpEntityId: e.target.value })}
              placeholder="https://idp.example.com/metadata"
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">IdP SSO URL</label>
            <input
              className="finding-edit-input settings-field-grow"
              value={settings.saml.idpSsoUrl}
              onChange={(e) => setSaml({ idpSsoUrl: e.target.value })}
              placeholder="https://idp.example.com/sso/saml"
            />
          </div>
          <div className="settings-field-vertical">
            <label className="settings-label">IdP Certificate (PEM)</label>
            <textarea
              className="finding-edit-textarea"
              rows={4}
              value={settings.saml.idpCertificate}
              onChange={(e) => setSaml({ idpCertificate: e.target.value })}
              placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
            />
          </div>

          <div className="settings-group-title" style={{ marginTop: 8 }}>Service Provider</div>
          <div className="settings-field">
            <label className="settings-label">SP Entity ID</label>
            <input
              className="finding-edit-input settings-field-grow"
              value={settings.saml.spEntityId}
              onChange={(e) => setSaml({ spEntityId: e.target.value })}
              placeholder="https://bench.example.com"
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">ACS URL</label>
            <input
              className="finding-edit-input settings-field-grow"
              value={settings.saml.acsUrl}
              onChange={(e) => setSaml({ acsUrl: e.target.value })}
              placeholder="https://bench.example.com/auth/saml/callback"
            />
          </div>

          <div className="settings-group-title" style={{ marginTop: 8 }}>Options</div>
          <div className="settings-field">
            <label className="settings-label">Allow IdP-initiated SSO</label>
            <button
              type="button"
              className={`settings-switch${settings.saml.allowIdpInitiated ? ' settings-switch-on' : ''}`}
              onClick={() => setSaml({ allowIdpInitiated: !settings.saml.allowIdpInitiated })}
            >
              <span className="settings-switch-thumb" />
            </button>
          </div>
          <div className="settings-field">
            <label className="settings-label">NameID format</label>
            <select
              className="finding-edit-select"
              value={settings.saml.nameIdFormat}
              onChange={(e) => setSaml({ nameIdFormat: e.target.value })}
            >
              <option value="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">Email address</option>
              <option value="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">Persistent</option>
              <option value="urn:oasis:names:tc:SAML:2.0:nameid-format:transient">Transient</option>
              <option value="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">Unspecified</option>
            </select>
          </div>
        </div>
      ) : null}

      {/* ── User Management ── */}
      <div className="settings-section-header" style={{ marginTop: 8 }}>
        <h3 className="settings-section-title">User Management</h3>
        <p className="settings-section-description">Invite users and assign roles. Admins can manage settings and users; reviewers can create findings; viewers have read-only access.</p>
      </div>

      <div className="settings-group">
        {settings.users.length === 0 && (
          <div className="settings-empty">No users invited yet.</div>
        )}
        {settings.users.map((user, i) => (
          <div key={i} className="settings-user-row">
            <div className="settings-user-info">
              <span className="settings-user-email">{user.email}</span>
              <span className={`settings-user-status settings-user-status-${user.status}`}>{user.status}</span>
            </div>
            <div className="settings-user-actions">
              <select
                className="finding-edit-select settings-select-compact"
                value={user.role}
                onChange={(e) => updateUser(i, { role: e.target.value as any })}
              >
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              {user.status === 'active' ? (
                <button
                  type="button"
                  className="settings-category-remove"
                  onClick={() => updateUser(i, { status: 'disabled' })}
                  title="Disable"
                >&#x26D4;</button>
              ) : user.status === 'disabled' ? (
                <button
                  type="button"
                  className="settings-category-move"
                  onClick={() => updateUser(i, { status: 'active' })}
                  title="Re-enable"
                >&#x21BB;</button>
              ) : null}
              <button type="button" className="settings-category-remove" onClick={() => removeUser(i)} title="Remove">
                &#x2715;
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="settings-category-add">
        <input
          className="finding-edit-input settings-field-grow"
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); inviteUser(); } }}
          placeholder="user@example.com"
        />
        <select
          className="finding-edit-select settings-select-compact"
          value={newRole}
          onChange={(e) => setNewRole(e.target.value as any)}
        >
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <button type="button" className="baseline-action-btn baseline-action-btn-primary" onClick={inviteUser} disabled={!newEmail.trim()} title={!newEmail.trim() ? 'Enter an email address to invite' : undefined}>
          Invite
        </button>
      </div>

      {/* ── Service Accounts ── */}
      <div className="settings-section-header" style={{ marginTop: 8 }}>
        <h3 className="settings-section-title">Service Accounts</h3>
        <p className="settings-section-description">
          API keys for MCP, CLI, and CI/CD integrations. Store the full key on creation — only the prefix is shown after.
        </p>
      </div>

      <div className="settings-group">
        {settings.serviceAccounts.length === 0 && (
          <div className="settings-empty">No service accounts yet.</div>
        )}
        {settings.serviceAccounts.map((sa, i) => (
          <div key={i} className="settings-user-row">
            <div className="settings-key-info">
              <span className="settings-category-name">{sa.name}</span>
              <span className="settings-key-prefix">{sa.prefix}</span>
            </div>
            <div className="settings-user-actions">
              <select
                className="finding-edit-select settings-select-compact"
                value={sa.role}
                onChange={(e) => updateServiceAccount(i, { role: e.target.value as any })}
              >
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <button type="button" className="settings-category-remove" onClick={() => revokeServiceAccount(i)} title="Revoke">
                &#x2715;
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="settings-category-add">
        <input
          className="finding-edit-input settings-field-grow"
          value={newSaName}
          onChange={(e) => setNewSaName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createServiceAccount(); } }}
          placeholder="Account name (e.g. ci-pipeline)"
        />
        <select
          className="finding-edit-select settings-select-compact"
          value={newSaRole}
          onChange={(e) => setNewSaRole(e.target.value as any)}
        >
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <button type="button" className="baseline-action-btn baseline-action-btn-primary" onClick={createServiceAccount} disabled={!newSaName.trim()} title={!newSaName.trim() ? 'Name the account to generate a key' : undefined}>
          Generate
        </button>
      </div>

      <div className="settings-actions">
        <button className="baseline-action-btn baseline-action-btn-primary" type="submit">Save</button>
        {feedback}
      </div>
    </form>
  );
}

/* ════════════════════════════════════════════════════════════
   Editor Tab
   ════════════════════════════════════════════════════════════ */

function EditorTab({ settings, onChange }: { settings: EditorSettings; onChange: (s: EditorSettings) => void }) {
  const { save, feedback } = useSaveAction();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    save('editor', settings);
  };

  return (
    <form className="settings-section" onSubmit={handleSubmit}>
      <div className="settings-section-header">
        <h3 className="settings-section-title">Editor Preferences</h3>
        <p className="settings-section-description">Configure the code viewer appearance and behaviour.</p>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">Display</div>
        <div className="settings-field">
          <label className="settings-label">Font size (px)</label>
          <input
            className="finding-edit-input-sm"
            type="number"
            min="10"
            max="24"
            value={settings.fontSize}
            onChange={(e) => onChange({ ...settings, fontSize: parseInt(e.target.value) || 13 })}
          />
        </div>
        <div className="settings-field">
          <label className="settings-label">Tab size</label>
          <input
            className="finding-edit-input-sm"
            type="number"
            min="1"
            max="8"
            value={settings.tabSize}
            onChange={(e) => onChange({ ...settings, tabSize: parseInt(e.target.value) || 4 })}
          />
        </div>
        <div className="settings-field">
          <label className="settings-label">Word wrap</label>
          <button
            type="button"
            className={`settings-switch${settings.wordWrap ? ' settings-switch-on' : ''}`}
            onClick={() => onChange({ ...settings, wordWrap: !settings.wordWrap })}
          >
            <span className="settings-switch-thumb" />
          </button>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">New projects</div>
        <div className="settings-field">
          <label className="settings-label">Default repository folder</label>
          <input
            className="finding-edit-input settings-field-grow"
            value={settings.defaultRepoPath}
            onChange={(e) => onChange({ ...settings, defaultRepoPath: e.target.value })}
            placeholder="/home/user/repos"
          />
        </div>
      </div>

      <div className="settings-actions">
        <button className="baseline-action-btn baseline-action-btn-primary" type="submit">Save</button>
        {feedback}
      </div>
    </form>
  );
}

/* ════════════════════════════════════════════════════════════
   Scoring Tab
   ════════════════════════════════════════════════════════════ */

function ScoringTab({
  weights, onWeightsChange,
  categories, onCategoriesChange,
}: {
  weights: RiskWeights; onWeightsChange: (w: RiskWeights) => void;
  categories: string[]; onCategoriesChange: (c: string[]) => void;
}) {
  const riskAction = useSaveAction();
  const catAction = useSaveAction();
  const [newCategory, setNewCategory] = useState('');

  const updateWeight = (key: keyof RiskWeights, value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) onWeightsChange({ ...weights, [key]: num });
  };

  const handleSaveWeights = (e: React.FormEvent) => {
    e.preventDefault();
    riskAction.save('riskWeights', weights);
  };

  // Category helpers
  const addCategory = () => {
    const slug = newCategory.trim().toLowerCase().replace(/\s+/g, '-');
    if (!slug || categories.includes(slug)) return;
    onCategoriesChange([...categories, slug]);
    setNewCategory('');
  };

  const removeCategory = (cat: string) => onCategoriesChange(categories.filter((x) => x !== cat));

  const moveCategory = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= categories.length) return;
    const next = [...categories];
    [next[idx], next[target]] = [next[target], next[idx]];
    onCategoriesChange(next);
  };

  return (
    <>
      {/* Risk Score */}
      <form className="settings-section" onSubmit={handleSaveWeights}>
        <div className="settings-section-header">
          <h3 className="settings-section-title">Risk Score Formula</h3>
          <p className="settings-section-description">
            Score = (severity weights x findings) + (staleness x days since baseline) + (delta x new findings)
          </p>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">Severity Weights</div>
          {(['critical', 'high', 'medium', 'low', 'info'] as const).map((sev) => (
            <div key={sev} className="settings-field">
              <label className="settings-label">
                <span className={`severity-dot severity-${sev}`} />
                {sev.charAt(0).toUpperCase() + sev.slice(1)}
              </label>
              <input
                className="finding-edit-input-sm"
                type="number"
                step="0.1"
                value={weights[sev]}
                onChange={(e) => updateWeight(sev, e.target.value)}
              />
            </div>
          ))}
        </div>

        <div className="settings-group">
          <div className="settings-group-title">Other Weights</div>
          <div className="settings-field">
            <label className="settings-label">Staleness (per day)</label>
            <input
              className="finding-edit-input-sm"
              type="number"
              step="0.1"
              value={weights.stalenessWeight}
              onChange={(e) => updateWeight('stalenessWeight', e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Delta (per new finding)</label>
            <input
              className="finding-edit-input-sm"
              type="number"
              step="0.1"
              value={weights.deltaWeight}
              onChange={(e) => updateWeight('deltaWeight', e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Size (per feature)</label>
            <input
              className="finding-edit-input-sm"
              type="number"
              step="0.1"
              value={weights.sizeWeight}
              onChange={(e) => updateWeight('sizeWeight', e.target.value)}
            />
          </div>
        </div>

        <div className="settings-actions">
          <button className="baseline-action-btn baseline-action-btn-primary" type="submit">Save</button>
          {riskAction.feedback}
        </div>
      </form>

      {/* Finding Categories */}
      <div className="settings-section">
        <div className="settings-section-header">
          <h3 className="settings-section-title">Finding Categories</h3>
          <p className="settings-section-description">
            Categories available when classifying findings. Order determines display priority.
          </p>
        </div>

        <div className="settings-group">
          {categories.map((cat, i) => (
            <div key={cat} className="settings-category-row">
              <span className="settings-category-name">{cat}</span>
              <div className="settings-category-actions">
                <button type="button" className="settings-category-move" disabled={i === 0} onClick={() => moveCategory(i, -1)} title="Move up">&#x25B2;</button>
                <button type="button" className="settings-category-move" disabled={i === categories.length - 1} onClick={() => moveCategory(i, 1)} title="Move down">&#x25BC;</button>
                <button type="button" className="settings-category-remove" onClick={() => removeCategory(cat)} title="Remove">&#x2715;</button>
              </div>
            </div>
          ))}
        </div>

        <div className="settings-category-add">
          <input
            className="finding-edit-input settings-field-grow"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCategory(); } }}
            placeholder="new-category"
          />
          <button type="button" className="baseline-action-btn baseline-action-btn-primary" onClick={addCategory} disabled={!newCategory.trim()}>
            Add
          </button>
        </div>

        <div className="settings-actions">
          <button type="button" className="baseline-action-btn baseline-action-btn-primary" onClick={() => catAction.save('categories', categories)}>
            Save
          </button>
          <button type="button" className="baseline-action-btn baseline-action-btn-outline" onClick={() => onCategoriesChange(DEFAULT_CATEGORIES)}>
            Reset to defaults
          </button>
          {catAction.feedback}
        </div>
      </div>
    </>
  );
}
