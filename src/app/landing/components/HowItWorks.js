"use client";

export default function HowItWorks() {
  return (
    <section className="py-24 border-y border-[#3a2f27] bg-[#23180f]/30" id="how-it-works">
      <div className="max-w-7xl mx-auto px-6">
        <div className="mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">How VIKCOM Works</h2>
          <p className="text-gray-400 max-w-xl text-lg">
            Data flows seamlessly from your application through our intelligent routing layer to the best provider for the job.
          </p>
        </div>
        
        <div className="text-center max-w-2xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">How VIKCOM Proxy Works</h2>
          <p className="text-gray-400">
            A single, intelligent proxy layer that intercepts, translates, and routes your AI requests transparently.
          </p>
        </div>

        {/* 3-Step Process Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Step 1: CLI Tools */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-6 hover:border-[#f97815]/50 transition-colors">
            <div className="size-12 rounded-lg bg-[#f97815]/10 text-[#f97815] flex items-center justify-center mb-4">
              <span className="material-symbols-outlined text-2xl">terminal</span>
            </div>
            <h3 className="text-xl font-bold mb-2 text-[#f97815]">1. CLI Tools</h3>
            <p className="text-gray-400 text-sm">
              Antigravity, Claude Code, Goose, and other AI coding assistants connect to local endpoint.
            </p>
          </div>

          {/* Step 2: VIKCOM Hub */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-6 hover:border-[#f97815]/50 transition-colors">
            <div className="size-12 rounded-lg bg-[#f97815]/10 text-[#f97815] flex items-center justify-center mb-4">
              <span className="material-symbols-outlined text-2xl">hub</span>
            </div>
            <h3 className="text-xl font-bold mb-2 text-[#f97815]">2. VIKCOM Hub</h3>
            <p className="text-sm text-gray-400">
              Our engine analyzes the prompt, checks provider health, and routes for lowest latency or cost.
            </p>
          </div>

          {/* Step 3: AI Providers */}
          <div className="flex flex-col gap-6 relative group md:items-end md:text-right">
            <div className="w-24 h-24 rounded-2xl bg-[#181411] border border-[#3a2f27] flex items-center justify-center shadow-xl group-hover:border-gray-500 transition-colors z-10 mx-auto md:mx-0">
              <div className="grid grid-cols-2 gap-2">
                <div className="w-6 h-6 rounded bg-white/10"></div>
                <div className="w-6 h-6 rounded bg-white/10"></div>
                <div className="w-6 h-6 rounded bg-white/10"></div>
                <div className="w-6 h-6 rounded bg-white/10"></div>
              </div>
            </div>
            <div>
              <h3 className="text-xl font-bold mb-2">3. AI Providers</h3>
              <p className="text-sm text-gray-400">
                The request is fulfilled by OpenAI, Anthropic, Gemini, or others instantly.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

