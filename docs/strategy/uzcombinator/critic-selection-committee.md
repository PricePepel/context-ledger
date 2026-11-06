**Committee review: Ledger Handover memo**

**Claims the cited research does not support**
- **"The product works."** The repo has no signing, verifier or redaction code. The only match for ed25519, signature, verify or redact is in `C:\Users\Asus\Desktop\context-ledger\tests\graph.test.mjs`. Every feature the memo says makes this sellable is in §8, "Add as P0". What exists is a memory and graph CLI, the part the memo itself calls commoditized.
- **AMI and Business of Story** survey marketing and ad agencies, not software vendors. The 65% figure is about disclosing *how client data is protected*, not where code came from. Using it as proof of demand from dev clients misuses it.
- **"Entire could ship in 1–3 months"** cites a GitHub repo. That is an analyst's estimate, not something the repo shows. The "6–12 month window" cites Entire's launch post, which says nothing about timing.
- **Export quotas** apply to *large* residents. The ICP is firms with 3–30 staff, so "keeping foreign clients becomes mandatory" does not follow for your buyers.
- **The $4–10M governance seeds** all come from aggregator sites. The fundability brief says none were checked against primary sources.
- **Yurideks as the closest alumnus.** Legal voice AI with 200 community members and 8 months of work is not comparable to a pre-interview dev tool.
- **The $40–150K cheque** is a blend of numbers. Nothing in the research says it is UzCombinator's own cheque size.

**Inflated or inconsistent numbers**
- **Acceptance ~4% as-is** is 5x the latest base rate (0.73–0.84%), for a solo founder outside the RFS with zero interviews. That is not calibrated.
- **~30% chance of 10 paying in 90 days** means converting about 29% of a 35-agency pool that is UNVERIFIED and has never been interviewed. The base case then *assumes* this 30% outcome happens.
- **Uzbek accounts exceed the fit pool.** By Q6, 40% of 95 accounts is 38 Uzbek accounts, which is more than the 35 fit agencies in the memo's own count.
- **Demo Day target of 3 paying at $1–3K MRR.** At $75–149/mo that is $225–450. The target is off by 3–10x.
- **TAM doubles Clutch's 49,221 to 100k** without support. It also turns 90% of *developers* using agents weekly into 80% of *firms*, and prices every account at the export rate.
- **The $140M enterprise TAM** stacks three UNVERIFIED multipliers on a secondary Copilot figure.
- **The $20k enterprise pilot in Q4** has no recipient conversation behind it, and the memo admits Year 1 only beats the sizing model because of that pilot.
- **3% churn** is invented for a product whose revenue the research calls "spiky" and tied to project endings.

**Eligibility problems**
- Citizenship and residency are unknown. The main Demo Day money, Yoshlar, backs Uzbek founders.
- Solo founders are explicitly "harder". "Recruit a co-founder before 10 Nov" means doing it in four days, which is not a plan.
- The RFS asks for *local replacements for foreign software*. This product sells to foreign enterprises and is not a replacement for anything. The "AI governance for IT exports" reframe is a stretch the jury will see through.
- The program requires 45 days full-time in Tashkent, and that has not been confirmed.
- The deadline is unresolved: the site shows both "10 Nov" and "34 days left".

**Three questions that sink the interview**
1. "How many agency owners have you spoken to, and which one would show this packet to a client?" The honest answer is zero, while Yurideks came in with 30+ lawyers.
2. "The agency holds the signing key and chooses which sessions to import. What does the signature prove to the client beyond 'the vendor says so'?" Right now it proves who signed, not that the record is complete. That is the core of the thesis, and the memo never addresses it.
3. "Entire has $60M, about 50 staff and already captures sessions. Why can't they add approve-and-sign in one sprint, and why is a solo founder in Tashkent the one to win?"

**Corrected verdict**
Pre-validation project, not fundable yet.
- Acceptance as-is: about 1%.
- With a real co-founder, 20+ interviews and 2 LOIs: maybe 3–5%.
- 10 paying in 90 days: about 10%.
- Submit anyway, because the form takes 10 minutes. But stop calling it fundable or venture-scale until one enterprise recipient has verified a packet.

**Five changes the memo must make**
1. **Separate what is built from what is planned.** Either ship a working signed packet plus offline verifier before submitting, or say it does not exist. Delete "the product works."
2. **Recalibrate the numbers.** Anchor acceptance to 0.73–0.84%. Make the base case conditional on interview results. Remove the enterprise pilot until there is a recipient LOI. Fix the Demo Day MRR target to match the pricing, or change the pricing. Fix the Uzbek count so it stays within the fit pool.
3. **Remove or relabel misapplied evidence.** Mark AMI and Business of Story as marketing-agency data. Restrict the quota point to large residents. Label the Entire timing as an estimate. Settle whether Trails actually exists.
4. **Rebuild sizing from verified counts.** Start from Clutch's 49k globally and the roughly 33 Uzbek firms actually listed on Clutch. Drop the $140M upsell from the headline. Show the local cap honestly as a few tens of thousands of dollars.
5. **Add a threat model and an eligibility plan.**
   - Threat model: tie packets to client-visible commit hashes, offer optional client countersignature, and state plainly what the signature does not prove.
   - Eligibility plan: confirm citizenship, full-time status and the 45 days in Tashkent. Show a dated pipeline of interviews and the co-founder search, not a four-day promise.
