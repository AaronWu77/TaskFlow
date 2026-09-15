import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, Mail, Lock, Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react';
import { ApiError, apiConfirmAccountRestore, apiConfirmPasswordReset, apiLogin, apiRegister, apiRequestAccountRestore, apiRequestPasswordReset, apiResendVerification, apiVerifyEmail, type AuthUser } from './api';
import { useTranslation } from 'react-i18next';

interface AuthPageProps {
  onAuth: (user: AuthUser) => void;
  savedEmail?: string;
}

export function AuthPage({ onAuth, savedEmail }: AuthPageProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'login' | 'register' | 'verify' | 'reset-request' | 'reset-confirm' | 'restore-confirm'>('login');
  const [email, setEmail] = useState(savedEmail || '');
  const [pendingEmail, setPendingEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [devCode, setDevCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const passwordChecks = [
    { key: 'length', passed: password.length >= 8 },
    { key: 'letter', passed: /[A-Za-z]/.test(password) },
    { key: 'number', passed: /\d/.test(password) },
  ];

  const inputClass =
    'flex h-11 w-full rounded-xl border border-input bg-input-background px-4 py-2 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors';

  function authErrorMessage(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.code === 'INVALID_EMAIL') return t('auth.errors.invalidEmail');
      if (err.code === 'WEAK_PASSWORD') return t('auth.errors.weakPassword');
      if (err.code === 'INVALID_CREDENTIALS') return t('auth.errors.invalidCredentials');
      if (err.code === 'EMAIL_NOT_VERIFIED' || err.code === 'INVALID_VERIFICATION_CODE'
        || err.code === 'INVALID_PASSWORD_RESET' || err.code === 'INVALID_ACCOUNT_RESTORE') return t('auth.errors.invalidCode');
      if (err.code === 'EMAIL_DELIVERY_FAILED') return t('auth.errors.emailDelivery');
      if (err.code === 'RATE_LIMITED' || err.status === 429) return t('auth.errors.rateLimited');
      if (err.code === 'NOT_FOUND' || err.code === 'API_VERSION_UNSUPPORTED' || err.status === 404 || err.status === 426) return t('auth.errors.apiIncompatible');
      if (err.status >= 500) return t('auth.errors.serviceUnavailable');
    }
    if (err instanceof DOMException && err.name === 'AbortError') return t('auth.errors.timeout');
    if (!navigator.onLine || err instanceof TypeError) return t('auth.errors.network');
    const message = err instanceof Error ? err.message : '';
    const normalized = message.toLowerCase();
    if (normalized.includes('invalid credentials') || normalized.includes('invalid email or password')) return t('auth.errors.invalidCredentials');
    if (normalized.includes('valid email')) return t('auth.errors.invalidEmail');
    if (normalized.includes('password') && normalized.includes('8')) return t('auth.errors.weakPassword');
    if (normalized.includes('already registered') || normalized.includes('already exists')) return t('auth.errors.emailExists');
    if (normalized.includes('verification') || normalized.includes('code')) return t('auth.errors.invalidCode');
    if (normalized.includes('delivery') || normalized.includes('configured')) return t('auth.errors.emailDelivery');
    return t('auth.errors.generic');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    setError('');
    setMessage('');
    setLoading(true);
    try {
      if (mode === 'verify') {
        const result = await apiVerifyEmail(pendingEmail || email.trim().toLowerCase(), verificationCode);
        onAuth(result.user);
        return;
      }
      if (mode === 'reset-request') {
        const targetEmail = email.trim().toLowerCase();
        const result = await apiRequestPasswordReset(targetEmail);
        setPendingEmail(targetEmail);
        setDevCode(result.devCode || '');
        setVerificationCode(result.devCode || '');
        setPassword('');
        setMode('reset-confirm');
        setMessage(t('auth.resetCodeSent'));
        return;
      }
      if (mode === 'reset-confirm') {
        if (passwordChecks.some(check => !check.passed)) {
          setError(t('auth.errors.weakPassword'));
          return;
        }
        await apiConfirmPasswordReset(pendingEmail || email.trim().toLowerCase(), verificationCode, password);
        setMode('login');
        setVerificationCode('');
        setPassword('');
        setMessage(t('auth.passwordResetSuccess'));
        return;
      }
      if (mode === 'restore-confirm') {
        const result = await apiConfirmAccountRestore(pendingEmail || email.trim().toLowerCase(), password, verificationCode);
        onAuth(result.user);
        return;
      }
      const fn = mode === 'login' ? apiLogin : apiRegister;
      if (mode === 'register' && passwordChecks.some(check => !check.passed)) {
        setError(t('auth.errors.weakPassword'));
        return;
      }
      const result = await fn(email.trim().toLowerCase(), password);
      if ('requiresEmailVerification' in result) {
        setPendingEmail(result.user.email);
        setDevCode(result.devCode || '');
        setVerificationCode(result.devCode || '');
        setMode('verify');
        return;
      }
      onAuth(result.user);
    } catch (err) {
      if (mode === 'login' && err instanceof ApiError && err.code === 'ACCOUNT_PENDING_DELETION') {
        try {
          const targetEmail = email.trim().toLowerCase();
          const result = await apiRequestAccountRestore(targetEmail, password);
          setPendingEmail(targetEmail);
          setDevCode(result.devCode || '');
          setVerificationCode(result.devCode || '');
          setMode('restore-confirm');
          setMessage(t('auth.restoreCodeSent'));
          return;
        } catch (restoreError) {
          setError(authErrorMessage(restoreError));
          return;
        }
      }
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    const targetEmail = pendingEmail || email.trim().toLowerCase();
    if (!targetEmail) return;
    setError('');
    setResending(true);
    try {
      const result = await apiResendVerification(targetEmail);
      setDevCode(result.devCode || '');
      if (result.devCode) setVerificationCode(result.devCode);
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setResending(false);
    }
  }

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const updateKeyboardState = () => {
      setKeyboardOpen(window.innerHeight - viewport.height > 120);
    };
    updateKeyboardState();
    viewport.addEventListener('resize', updateKeyboardState);
    return () => viewport.removeEventListener('resize', updateKeyboardState);
  }, []);

  return (
    <div className={`app-viewport bg-background text-foreground flex flex-col items-center overflow-y-auto overscroll-none px-6 ${keyboardOpen ? 'pt-safe pb-4 justify-start' : 'app-safe-y justify-center'}`}>
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 340, damping: 28 }}
        className={`w-full max-w-[360px] ${keyboardOpen ? 'mt-4 mb-4' : ''}`}
      >
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 bg-primary/10 text-primary rounded-2xl flex items-center justify-center mb-4">
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">TaskFlow</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {mode === 'verify' ? t('auth.verifyTitle')
              : mode === 'reset-request' || mode === 'reset-confirm' ? t('auth.resetPassword')
                : mode === 'restore-confirm' ? t('auth.restoreAccount')
                  : mode === 'login' ? t('auth.welcomeBack') : t('auth.createAccount')}
          </p>
        </div>

        {/* Card */}
        <div className="bg-card border border-border rounded-3xl p-6 shadow-sm">
          {/* Mode toggle */}
          {(mode === 'login' || mode === 'register') && <div className="flex bg-muted rounded-xl p-1 mb-6">
            {(['login', 'register'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setMode(m); setError(''); setDevCode(''); }}
                className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all ${
                  mode === m
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {m === 'login' ? t('auth.signIn') : t('auth.signUp')}
              </button>
            ))}
          </div>}

          <form onSubmit={handleSubmit} className="space-y-4">
            {(mode === 'verify' || mode === 'reset-confirm' || mode === 'restore-confirm') ? (
              <>
                <div className="rounded-2xl bg-primary/10 p-4 text-sm text-muted-foreground">
                  <div className="mb-2 flex items-center gap-2 font-semibold text-foreground">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    {mode === 'verify' ? t('auth.verifyHeading') : mode === 'reset-confirm' ? t('auth.resetHeading') : t('auth.restoreHeading')}
                  </div>
                  <p>{mode === 'verify'
                    ? t('auth.verifyDescription', { email: pendingEmail || email })
                    : mode === 'reset-confirm'
                      ? t('auth.resetDescription', { email: pendingEmail || email })
                      : t('auth.restoreDescription', { email: pendingEmail || email })}</p>
                </div>

                <div className="space-y-2">
                  <label htmlFor="auth-code" className="text-sm font-medium">{t('auth.verificationCode')}</label>
                  <input
                    id="auth-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder={t('auth.verificationCodePlaceholder')}
                    required
                    maxLength={6}
                    value={verificationCode}
                    onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className={`${inputClass} text-center tracking-[0.35em]`}
                  />
                  {devCode && (
                    <p className="text-xs text-muted-foreground">
                      {t('auth.devCode', { code: devCode })}
                    </p>
                  )}
                </div>
                {(mode === 'reset-confirm' || mode === 'restore-confirm') && (
                  <div className="space-y-2">
                    <label htmlFor="auth-recovery-password" className="text-sm font-medium">
                      {mode === 'reset-confirm' ? t('auth.newPassword') : t('auth.password')}
                    </label>
                    <input
                      id="auth-recovery-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete={mode === 'reset-confirm' ? 'new-password' : 'current-password'}
                      required
                      minLength={8}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      className={inputClass}
                    />
                    {mode === 'reset-confirm' && passwordChecks.map(check => (
                      <span key={check.key} className={`block text-xs ${check.passed ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                        {check.passed ? t('auth.passwordRules.passed') : t('auth.passwordRules.pending')} {t(`auth.passwordRules.${check.key}`)}
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
            {/* Email */}
            <div className="space-y-2">
              <label htmlFor="auth-email" className="text-sm font-medium">{t('auth.email')}</label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <input
                  id="auth-email"
                  type="email"
                  autoComplete="email"
                  placeholder={t('auth.emailPlaceholder')}
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={`${inputClass} pl-10`}
                />
              </div>
            </div>

            {/* Password */}
            {mode !== 'reset-request' && <div className="space-y-2">
              <label htmlFor="auth-password" className="text-sm font-medium">
                {t('auth.password')} {mode === 'register' && <span className="text-muted-foreground font-normal">{t('auth.passwordHint')}</span>}
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <input
                  id="auth-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  placeholder={t('auth.passwordPlaceholder')}
                  required
                  minLength={mode === 'register' ? 8 : undefined}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`${inputClass} pl-10 pr-10`}
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {mode === 'register' && (
                <div className="grid grid-cols-1 gap-1 text-xs">
                  {passwordChecks.map(check => (
                    <span key={check.key} className={check.passed ? 'text-emerald-600' : 'text-muted-foreground'}>
                      {check.passed ? t('auth.passwordRules.passed') : t('auth.passwordRules.pending')} {t(`auth.passwordRules.${check.key}`)}
                    </span>
                  ))}
                </div>
              )}
            </div>}
              </>
            )}

            {/* Error */}
            <AnimatePresence>
              {error && (
                <motion.p
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2"
                >
                  {error}
                </motion.p>
              )}
            </AnimatePresence>

            {message && <p className="rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary">{message}</p>}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 bg-primary text-primary-foreground rounded-xl font-semibold text-base hover:bg-primary/90 transition-colors active:scale-95 disabled:opacity-60 disabled:scale-100 flex items-center justify-center gap-2 mt-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {mode === 'verify' ? t('auth.verifyAndContinue')
                : mode === 'reset-request' ? t('auth.sendResetCode')
                  : mode === 'reset-confirm' ? t('auth.confirmReset')
                    : mode === 'restore-confirm' ? t('auth.confirmRestore')
                      : mode === 'login' ? t('auth.signIn') : t('auth.createAccount')}
            </button>
            {mode === 'verify' && (
              <div className="flex items-center justify-between gap-3 text-sm">
                <button
                  type="button"
                  disabled={resending}
                  onClick={handleResend}
                  className="font-semibold text-primary disabled:opacity-60"
                >
                  {resending ? t('auth.resending') : t('auth.resendCode')}
                </button>
                <button
                  type="button"
                  onClick={() => { setMode('login'); setVerificationCode(''); setDevCode(''); setError(''); }}
                  className="font-semibold text-muted-foreground"
                >
                  {t('auth.backToSignIn')}
                </button>
              </div>
            )}
            {mode === 'login' && (
              <button type="button" onClick={() => { setMode('reset-request'); setError(''); setMessage(''); }} className="w-full text-sm font-semibold text-primary">
                {t('auth.forgotPassword')}
              </button>
            )}
            {(mode === 'reset-request' || mode === 'reset-confirm' || mode === 'restore-confirm') && (
              <button type="button" onClick={() => { setMode('login'); setVerificationCode(''); setDevCode(''); setError(''); setMessage(''); }} className="w-full text-sm font-semibold text-muted-foreground">
                {t('auth.backToSignIn')}
              </button>
            )}
          </form>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          {t('auth.privacyNote')}
        </p>
      </motion.div>
    </div>
  );
}
