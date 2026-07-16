# NoLimits site design QA

- Source visual truth: https://getlimits.app
- Source capture: `/tmp/getlimits-reference.png`
- Implementation: https://nolimits-murex.vercel.app
- Desktop capture: `screenshots/site-desktop.png`
- Mobile capture: `/tmp/nolimits-site-mobile.png`
- Viewports: 1280 x 720 desktop; 390 x 720 mobile
- State: landing-page default, light appearance

## Full-view comparison evidence

The reference and implementation were captured together at 1280 x 720. Both use
the same quiet white canvas, compact three-part navigation, oversized two-tone
headline, restrained supporting copy, pill actions, and product imagery anchored
to the right. No P0, P1, or P2 differences remain.

## Required fidelity surfaces

- Fonts and typography: system display stack, heavy optical headline, compact
  body copy, and muted second headline line match the reference hierarchy.
- Spacing and layout rhythm: wide desktop shell, generous hero whitespace,
  balanced two-column composition, and stacked mobile actions remain intact.
- Colors and visual tokens: near-black ink, cool gray secondary type, soft blue
  and coral light washes, and low-contrast borders match the source direction.
- Image quality and asset fidelity: every product image is a direct iOS
  Simulator or WidgetKit capture; provider marks use the app's source assets.
- Copy and content: NoLimits-specific providers, private Railway/Upstash model,
  and GitHub call to action are accurate.

Focused-region comparison was not needed: the hero typography, actions, provider
marks, app screenshot, and widget screenshot are readable in the desktop capture.
The separate 390 px capture verifies the responsive treatment.

## Interaction and technical checks

- GitHub links resolve to `https://github.com/Tar-ive/nolimits`.
- Navigation anchors, app capture, and widget capture are present.
- Desktop and mobile browser consoles reported no errors.
- Production returned HTTP 200 from Vercel.

## Comparison history

The first implementation comparison had no actionable P0, P1, or P2 findings.
Widget secondary labels were corrected before the final source capture so all five
provider labels remain readable.

## Follow-up polish

- P3: add a custom domain when the final product domain is chosen.

final result: passed
