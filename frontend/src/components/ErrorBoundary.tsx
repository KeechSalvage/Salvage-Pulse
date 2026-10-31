import React, { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught application error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0B0F17] flex items-center justify-center p-6 text-slate-200">
          <div className="max-w-md w-full bg-[#151D2A] border border-red-500/30 rounded-2xl p-6 shadow-2xl text-center">
            <div className="w-12 h-12 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4 text-red-400">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-white mb-2">Something went wrong</h2>
            <p className="text-sm text-slate-400 mb-6 leading-relaxed">
              An unexpected render error occurred. You can restore your Master Admin session to get back to the console, or try reloading.
            </p>
            <div className="flex flex-col gap-3">
              <button
                onClick={() => { window.location.href = "/"; }}
                className="w-full py-2.5 px-4 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-sm transition-colors text-center shadow-sm"
              >
                Return to Dashboard
              </button>
              <button
                onClick={() => window.location.reload()}
                className="w-full py-2.5 px-4 rounded-lg bg-white/10 hover:bg-white/15 text-white font-medium text-sm transition-colors"
              >
                Reload Page
              </button>
            </div>
            {this.state.error && (
              <details className="mt-4 text-left">
                <summary className="text-xs text-slate-500 hover:text-slate-400 cursor-pointer">
                  Technical error details
                </summary>
                <pre className="mt-2 text-[11px] font-mono bg-black/40 p-2.5 rounded text-red-300 overflow-x-auto whitespace-pre-wrap">
                  {this.state.error.message || String(this.state.error)}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
