'use client';
import { useEffect, useState } from 'react';
import AuthGate from '../../components/AuthGate';
import { useTelegramUser } from '../../components/TelegramProvider';
import { api } from '../../lib/api';
import { notifyHaptic } from '../../lib/telegram';

const DEPOSIT_PHONE = process.env.NEXT_PUBLIC_DEPOSIT_PHONE || '0968200522';

function WalletContent() {
  const { user, refreshProfile } = useTelegramUser();
  const [tab, setTab] = useState('deposit');

  return (
    <div className="px-5 pt-8 pb-8">
      <h1 className="font-display font-semibold text-2xl text-ivory mb-1">Wallet</h1>
      <p className="font-mono text-gold text-3xl font-semibold mb-6">{user.mainWalletBalance} <span className="text-sm text-mute font-body">Birr</span></p>

      <div className="flex bg-surface2 rounded-chip p-1 mb-6 text-sm">
        {['deposit', 'withdraw', 'history'].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 rounded-chip capitalize transition-colors ${tab === t ? 'bg-gold text-ink font-semibold' : 'text-mute'}`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'deposit' && <DepositTab onSuccess={refreshProfile} />}
      {tab === 'withdraw' && <WithdrawTab balance={user.mainWalletBalance} onSuccess={refreshProfile} />}
      {tab === 'history' && <HistoryTab />}
    </div>
  );
}

function depositPendingReason(reason) {
  const messages = {
    UNPARSEABLE: "We couldn't read that as a Telebirr confirmation — an admin will review it manually.",
    FETCH_FAILED: "We couldn't reach the Telebirr receipt page just now — an admin will review it manually.",
    TRANSACTION_ID_NOT_FOUND: "The receipt page didn't match — an admin will review it manually.",
    AMOUNT_MISMATCH: "The amount on the receipt didn't match what you entered — an admin will review it manually.",
    RECIPIENT_MISMATCH: "This payment doesn't appear to have been sent to our account — an admin will review it manually."
  };
  return messages[reason] || 'We could not verify this automatically — an admin will review it shortly.';
}

function DepositTab({ onSuccess }) {
  const [step, setStep] = useState('amount');
  const [amount, setAmount] = useState('');
  const [proof, setProof] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.requestDeposit(Number(amount), proof.trim());
      setResult(res);
      notifyHaptic(res.status === 'COMPLETED' ? 'success' : 'warning');
      if (res.status === 'COMPLETED') onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="bg-surface border border-line rounded-card p-5 text-center">
        <div className="text-3xl mb-2">{result.status === 'COMPLETED' ? '✅' : '⏳'}</div>
        <p className="font-display font-semibold text-ivory mb-1">
          {result.status === 'COMPLETED' ? 'Deposit Successful!' : 'Verification Pending'}
        </p>
        <p className="text-mute text-sm mb-4">
          {result.status === 'COMPLETED' ? `Your wallet has been credited with ${result.amount} Birr.` : depositPendingReason(result.reason)}
        </p>
        <button onClick={() => { setStep('amount'); setResult(null); setAmount(''); setProof(''); }} className="text-gold text-sm font-medium">
          Make another deposit
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {step === 'amount' ? (
        <>
          <label className="block text-mute text-xs uppercase tracking-wide mb-1">Amount (Birr)</label>
          <input
            type="number"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="e.g. 100"
            className="w-full bg-surface2 border border-line rounded-chip px-4 py-3 text-ivory font-mono outline-none focus:border-gold"
          />
          <button
            disabled={!amount || Number(amount) < 10}
            onClick={() => setStep('proof')}
            className="w-full bg-gold disabled:bg-line disabled:text-mute text-ink font-display font-semibold py-3 rounded-card"
          >
            Continue
          </button>
        </>
      ) : (
        <>
          <div className="bg-surface2 border border-line rounded-card p-4 text-sm">
            <p className="text-mute mb-1">Send <span className="text-gold font-semibold">{amount} Birr</span> via Telebirr to:</p>
            <p className="font-mono text-ivory text-lg mb-3">{DEPOSIT_PHONE}</p>
            <p className="text-mute text-xs">Then paste the <span className="text-ivory">entire confirmation SMS</span> from Telebirr below — not just the link or transaction number.</p>
          </div>
          <textarea
            value={proof}
            onChange={(e) => setProof(e.target.value)}
            placeholder="Paste the full Telebirr confirmation message here"
            rows={5}
            className="w-full bg-surface2 border border-line rounded-chip px-4 py-3 text-ivory text-sm outline-none focus:border-gold"
          />
          {error && <p className="text-coral text-sm">{error}</p>}
          <button
            disabled={!proof.trim() || busy}
            onClick={submit}
            className="w-full bg-gold disabled:bg-line disabled:text-mute text-ink font-display font-semibold py-3 rounded-card"
          >
            {busy ? 'Verifying…' : 'Submit Proof'}
          </button>
        </>
      )}
    </div>
  );
}

function WithdrawTab({ balance, onSuccess }) {
  const [amount, setAmount] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.requestWithdrawal(Number(amount));
      setResult(res);
      notifyHaptic('success');
      onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="bg-surface border border-line rounded-card p-5 text-center">
        <div className="text-3xl mb-2">⏳</div>
        <p className="font-display font-semibold text-ivory mb-1">Withdrawal Requested</p>
        <p className="text-mute text-sm mb-4">
          {result.amount} Birr is on hold and pending admin approval. You&apos;ll be notified once it&apos;s processed.
        </p>
        <button onClick={() => { setResult(null); setAmount(''); }} className="text-gold text-sm font-medium">
          Request another withdrawal
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <label className="block text-mute text-xs uppercase tracking-wide mb-1">Amount (Birr)</label>
      <input
        type="number"
        inputMode="numeric"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="e.g. 200"
        className="w-full bg-surface2 border border-line rounded-chip px-4 py-3 text-ivory font-mono outline-none focus:border-coral"
      />
      <p className="text-mute text-xs">Available balance: {balance} Birr</p>
      {error && <p className="text-coral text-sm">{error}</p>}
      <button
        disabled={!amount || Number(amount) <= 0 || Number(amount) > balance || busy}
        onClick={submit}
        className="w-full bg-coral disabled:bg-line disabled:text-mute text-ink font-display font-semibold py-3 rounded-card"
      >
        {busy ? 'Submitting…' : 'Request Withdrawal'}
      </button>
    </div>
  );
}

function HistoryTab() {
  const [transactions, setTransactions] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getTransactions({ limit: 20 })
      .then(({ transactions: list }) => setTransactions(list))
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="text-coral text-sm">{error}</p>;
  if (!transactions) return <p className="text-mute text-sm">Loading…</p>;
  if (transactions.length === 0) return <p className="text-mute text-sm">No transactions yet.</p>;

  return (
    <div className="space-y-2">
      {transactions.map((t) => (
        <div key={t._id} className="flex items-center justify-between bg-surface border border-line rounded-chip px-4 py-3">
          <div>
            <p className="text-ivory text-sm">{formatType(t.type)}</p>
            <p className="text-mute text-[11px]">{new Date(t.timestamp).toLocaleString()} · {t.status}</p>
          </div>
          <p className={`font-mono text-sm ${['DEPOSIT', 'WINNING', 'ADMIN_CREDIT'].includes(t.type) ? 'text-emerald' : 'text-ivory'}`}>
            {['DEPOSIT', 'WINNING', 'ADMIN_CREDIT'].includes(t.type) ? '+' : '-'}{t.amount} Birr
          </p>
        </div>
      ))}
    </div>
  );
}

function formatType(type) {
  return type.replace(/_/g, ' ').replace(/\w\S*/g, (w) => w[0] + w.slice(1).toLowerCase());
}

export default function WalletPage() {
  return (
    <AuthGate>
      <WalletContent />
    </AuthGate>
  );
}
