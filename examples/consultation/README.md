# consultation

A public consultation, synthesised: `submissions` in English, Hindi and Marathi with JSON `metadata`, a moderation status, a redaction flag, and two analysis tables — themes assigned per run, and a signal ("months waiting", "wants a human") extracted per submission. **No real consultation data is used**; every sentence is a template.

This is the origin domain of lenspack, and the pack is the proof that its special cases are gone: `theme` is an ordinary dimension on a one-to-one joined view (`v_submission_theme`, which reads only the latest completed run), and the signal's outputs are ordinary measures on `v_signal_wait`. The pack is multi-tenant (`tenant_id`), so every query must carry a tenant or it will not compile.

Questions it answers: themes ranked by priority (severity × actionability); flagged and redaction rates overall and by language; mean months waiting by district; who wants a human, by channel.
