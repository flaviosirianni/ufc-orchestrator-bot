# Mobile App Store Path

Recommended implementation target after Stitch design: Expo / React Native.

Reason:

- One mobile codebase for Android and iOS.
- Native app-store packaging through EAS Build.
- Practical support for camera, file upload, push notifications, secure storage, and mobile navigation.
- Good path for later web/PWA reuse if needed.

## Accounts Needed

- Apple Developer Program: required for App Store and TestFlight distribution. Current public Apple pricing is USD 99 per membership year.
- Google Play Console: required for Google Play distribution. Current public Google pricing is a USD 25 one-time registration fee.

## Health/Nutrition Store Requirements

Because this app handles health, medical, and nutrition data:

- Include a clear privacy policy before store submission.
- Include in-app account/data deletion path.
- Include data export/download path or support process.
- Avoid claims that the app diagnoses, treats, cures, or prevents medical conditions.
- Show medical disclaimers in onboarding, store metadata, and sensitive medical flows.
- Remind users to consult a healthcare professional for medical advice, diagnosis, or treatment.
- Complete Google Play health app declarations.
- For Apple review, provide demo credentials or a demo mode that exercises the full app.
- Do not use health or medical data for ads, behavioral targeting, or unrelated marketing.

## Product Positioning

Use this positioning consistently:

> Ovidius is a health organization and education companion. It helps users track nutrition, organize medical information, prepare for consultations, understand documents, and identify when professional care may be appropriate. It is not a doctor, not a medical device, and not a replacement for professional medical advice.

## Release Sequence

1. Generate mobile app concept in Stitch.
2. Import selected screens/design context into the repo.
3. Build Expo app shell with profile selector, auth placeholder, and navigation.
4. Add backend/API layer for existing nutrition and medical domain operations.
5. Add privacy, consent, and data-management screens before public beta.
6. Test through TestFlight and internal Play testing.
7. Submit store listings with accurate health disclaimers and reviewer demo access.

