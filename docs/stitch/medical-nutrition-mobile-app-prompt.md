# Stitch Prompt: App Mobile Medica + Nutricional

Copy the full prompt below into Google Stitch.

```text
Design a mobile-first consumer health companion app for iOS and Android.

The product combines two existing Telegram bots into one app:

1. "Ovidius", a longitudinal medical companion.
2. A nutrition companion for food logging, weight tracking, learning, and progress analysis.

Important: do not design this as a chatbot UI copied from Telegram. Rethink it as a real mobile app. Propose the navigation, hierarchy, screen map, and interaction model yourself. I want the interface proposal from Stitch, not a prescriptive visual direction from this prompt.

The app should feel trustworthy, practical, and easy to use for repeated daily health tracking. It is not a medical device and must not present itself as a replacement for a doctor, diagnosis, or treatment.

Language: user-facing copy should be in Spanish. Internal labels in this prompt are in English only for clarity.

## Product concept

The app has one account owner and multiple integrated profiles. A profile can represent the user or a family member. Each profile has both a medical area and a nutrition area, sharing relevant context when useful.

The user should be able to:

- Create and switch between profiles.
- Keep medical history organized by profile.
- Track nutrition, weight, objectives, and learning by profile.
- Upload photos, screenshots, or documents when relevant.
- Ask educational questions in controlled contexts.
- Review credits, usage, help, bug reports, and feature requests.

## Core navigation expectation

Please propose a mobile navigation model. It should include, at minimum:

- A profile selector or profile switcher.
- A profile home that summarizes the selected person's medical and nutrition status.
- A medical section.
- A nutrition section.
- A credits or billing section.
- A help and feedback section.
- A settings area.

Avoid making every action a plain chat screen. Use forms, lists, timelines, cards, summaries, upload flows, guided actions, and conversational entry points where they make sense.

## Profile model

Each profile should support:

- Label or display name, e.g. "Yo", "Mama", "Mi hijo Mateo".
- Relationship to account owner: self, child, partner, parent, grandparent, other.
- First name, last name, date of birth or approximate age.
- Biological sex.
- Active/default profile state.

Medical profile fields:

- Height, weight, blood type, location.
- Chronic conditions.
- Allergies and adverse reactions.
- Current medications.
- Family history.
- Surgeries.
- Hospitalizations.
- Habits and lifestyle notes.
- Vaccines.
- Pregnancy status when relevant.
- Freeform notes.

Nutrition profile fields:

- Main goal.
- Target calories per day.
- Target protein per day.
- Timezone.
- Age, sex, height, current weight.
- Activity level.
- Training type.
- Training frequency.
- Allergies and intolerances.
- Health condition.
- Relevant medication.
- Main difficulty.
- 8 to 12 week goal.
- Notes and restrictions.
- Fixed product aliases, for example "leche proteica" mapped to a known catalog product.

Onboarding should help create the first profile without overwhelming the user. It can ask whether the profile is for the user or someone else, then capture the most important details gradually.

## Medical area: Ovidius

The medical area is a professional companion for understanding symptoms, interpreting studies, organizing health information, detecting situations that require attention, preparing real medical consultations, and maintaining a structured medical memory per profile.

It must not claim to diagnose definitively or prescribe treatments. It should explain uncertainty clearly, recommend professional care when appropriate, and make urgent situations visually clear.

Main medical modules:

1. Consulta
2. Perfiles
3. Historia
4. Documentos
5. Prep. Consulta
6. Seguimiento
7. Creditos
8. Ajustes

### Medical module: Consulta

Functions:

- Symptom or medical problem consultation.
- Interpret a study.
- General medical question.
- Continue an open episode.

Desired app behavior:

- Let the user start a new symptom/problem consultation for the selected profile.
- Accept text, images, and document uploads where relevant.
- For symptom/problem consultations, show:
  - likely possibilities in accessible language,
  - key information still needed,
  - reassuring signs,
  - warning signs,
  - expected evolution,
  - when to consult,
  - what type of doctor or care level may be appropriate.
- For general medical questions, answer educationally without attaching the question to a profile unless the user clearly refers to a real patient.
- For follow-up, let the user update an active episode: better, worse, new symptoms, resolved, referred, or needs attention.

Urgency states:

- non_urgent: no special urgency marker.
- seek_soon: recommend seeing a doctor in the next few days.
- seek_today: recommend same-day medical attention.
- urgent: put the urgent recommendation first and make it prominent.

### Medical module: Perfiles

Functions:

- View profiles.
- Add person.
- Edit profile.
- Medical summary card.
- Select active/default profile.

Desired app behavior:

- Display profile list with relationship and default marker.
- Allow creating additional people.
- Allow editing medical profile fields.
- Generate a concise medical summary for the selected profile, including key profile data, active episodes, confirmed diagnoses, relevant conditions, allergies, medications, and open follow-ups.

### Medical module: Historia

Functions:

- Active episodes.
- Resolved episodes.
- Confirmed diagnoses.

Desired app behavior:

- Show a timeline or list of episodes per profile.
- Each episode can include title, status, date, chief complaint, symptoms, severity, duration, urgency level, advice given, follow-up note, related documents, and physician-confirmed diagnosis.
- Separate active from resolved episodes.
- Confirmed diagnoses must be clearly labeled as physician-confirmed, not generated diagnosis.

Episode statuses:

- active
- improving
- resolved
- escalated / referred to doctor

### Medical module: Documentos

Functions:

- Upload study.
- View recent documents.
- Search result.
- Compare studies.

Supported document types:

- laboratory
- imaging / radiology
- prescription
- discharge / epicrisis
- consultation note
- pathology
- vaccination
- symptom photo
- monitoring
- other medical document

Desired app behavior:

- Let users upload or capture a photo, image, screenshot, or PDF.
- Allow manual text entry when the user has values at hand.
- Store and show title, type, study date, upload date, summary, key findings, abnormal values, tags, and related episode.
- Search documents by title, summary, raw text, or document type.
- Compare a new study with prior comparable studies for the selected profile, showing what improved, worsened, stayed stable, or is new.

### Medical module: Prep. Consulta

Functions:

- Prepare a summary for a real doctor.
- Explain what the doctor said after a consultation.

Desired app behavior:

- For consultation prep, generate a shareable consultation brief:
  - main reason for visit,
  - symptom chronology,
  - what was already tried or ruled out,
  - medication and relevant studies,
  - concrete questions for the doctor.
- For post-consultation explanation, let the user paste text or upload a prescription, consultation note, or discharge summary.
- Explain diagnosis/procedure, medications, what to expect, next steps, and what each instruction means in plain Spanish.
- If a physician-confirmed diagnosis is extracted, associate it with the relevant recent episode only as confirmed by physician.

### Medical module: Seguimiento

Functions:

- View open follow-up topics.
- Update a topic.

Desired app behavior:

- Show open follow-up items across profiles and within each profile.
- Each item should include domain, description, related episode or document, due note if present, and status.
- Let the user mark items as resolved or update their status.

### Medical module: Ajustes and feedback

Settings:

- Response length: concise, detailed.
- Explanation depth: simple, standard, deep.
- Default patient behavior: ask, use default.

Feedback:

- Report bug.
- Request feature.
- Feedback requires text; no need to design media upload for feedback in v1.

## Nutrition area

The nutrition area is an operational daily tracker and educational companion. It should prioritize reliable logging, clear progress summaries, and practical learning.

Main nutrition modules:

1. Registro
2. Perfil / Objetivos
3. Estadisticas
4. Aprendizaje
5. Creditos
6. Ayuda

### Nutrition module: Registro

Functions:

- Log intake.
- Log weigh-in.
- Modify/delete intake.
- Modify/delete weigh-in.

#### Log intake

Desired app behavior:

- Let the user log food with simple text, for example "13:30 pollo con arroz + ensalada" or "mate con 2 tostadas con queso".
- Allow photo of food. If the image is clear, the system can infer and register; if not clear, ask for confirmation or clarification.
- If no date/time is provided, use the profile timezone and current time.
- Support batch logging: multiple meal lines in one input. Valid lines can be saved while invalid lines are returned for correction.
- Show confirmation with date, time, item details, calories, protein, carbs, fat, confidence, and status versus goal.
- Show item IDs so the user can later modify or delete specific entries.
- If the product seems packaged and nutrition data is uncertain, ask for a clear photo of the nutrition label.
- When a nutrition label is uploaded, extract portion, calories, protein, carbs, fat, fiber, sodium when available, and add/update it in a global food catalog.
- If data is estimated, allow saving but clearly show that it is estimated and suggest improving precision with package/front/label photos.
- Track catalog matches, user aliases, resolution mode, and confidence internally.

#### Modify/delete intake

Desired app behavior:

- Let the user delete by ID, last entry, time, item name, or date/time.
- Let the user modify temporal data by ID or reference, for example changing date or time.
- If the app cannot identify the target entry, show recent entries with IDs and ask the user to choose.
- After delete/modify, update the daily summary.

#### Log weigh-in

Desired app behavior:

- Let users enter text such as "81.4 kg" or "hoy 08:15 81.4 kg grasa 18.2% agua 56%".
- Allow photo/screenshot of a scale. If readable, save instantly.
- Support optional body metrics: body fat percent, visceral fat, muscle mass kg, body water percent, BMR, bone mass kg, notes.
- After image OCR save, allow quick "cancel" or "modify" correction flow.
- Show confirmation with date/time, weight, optional metrics, and latest status.

#### Modify/delete weigh-in

Desired app behavior:

- Let the user delete last weigh-in or a specific weigh-in by time/date.
- Let the user correct a recent OCR weigh-in.
- If target is ambiguous, show recent weigh-ins and ask the user to choose.

### Nutrition module: Perfil / Objetivos

Functions:

- View full nutrition profile.
- Update profile and goals.
- Manage product aliases/fixed products.

Desired app behavior:

- Show all nutrition profile fields.
- Allow editing one or multiple fields.
- Allow examples like:
  - objective: lose fat while maintaining muscle,
  - target: 2200 kcal and 170g protein,
  - timezone: America/Argentina/Buenos_Aires,
  - restrictions: lactose-free,
  - fixed product: "leche proteica" = "Leche Proteica La Serenisima",
  - list fixed products,
  - remove fixed product alias.
- Product alias mapping should help the app recognize frequently used packaged products.

Goal options from onboarding:

- Bajar grasa
- Ganar musculo
- Mejorar habitos / ansiedad
- Comer mejor sin dieta
- Mejorar salud y energia

### Nutrition module: Estadisticas

Functions:

- Today's summary.
- Yesterday's intakes.
- Weight history.
- Weekly trend.

Desired app behavior:

- Today's summary should show:
  - date and local time,
  - total calories, protein, carbs, fat,
  - rolling 7 day averages,
  - rolling 14 day averages,
  - comparison versus calorie/protein target,
  - latest weigh-in,
  - intake detail for the day,
  - status: sin objetivo configurado, bien, mas o menos, desalineado.
- Yesterday's intakes should show a dated list and totals.
- Weight history should show recent weigh-ins and optional body composition data.
- Weekly trend should show rolling 7d and 14d macro averages, target ratios, and recent weight delta if enough data exists.
- Personalized analysis should use profile, summary, recent intakes, and weight history to produce practical advice.

### Nutrition module: Aprendizaje

This is the only nutrition area with free educational chat. It must not mutate logs, weigh-ins, or profile unless the user explicitly changes to an operational module.

Functions:

- Tutorials.
- Personalized analysis.
- Free learning chat.

Tutorial levels and topics:

Basic:

- Calorias: que son y por que importan.
- Proteinas, carbohidratos y grasas.
- Como armar un plato equilibrado.
- Como leer etiquetas nutricionales.
- Comer mejor sin contar todo.

Intermediate:

- Proteina y saciedad.
- Fibra.
- Hambre fisica vs emocional.
- Fines de semana y situaciones sociales.
- Alcohol y nutricion.

Advanced:

- Deficit calorico sin perder musculo.
- Recomposicion corporal.
- Retencion de liquidos.
- Como interpretar el peso en la balanza.
- Como usar el bot al maximo.

Desired app behavior:

- Let users browse tutorials by level.
- Let users ask educational questions.
- If the user asks for personal historical data inside learning, answer from real stored data first rather than inventing.
- Keep responses practical and non-clinical.
- Avoid diagnosis or medical nutrition therapy.

### Nutrition module: Ayuda and feedback

Functions:

- Report bug.
- Request feature.

Desired app behavior:

- For bug report, ask:
  - what the user tried,
  - what they expected,
  - what actually happened.
- For feature request, ask:
  - what they want to do,
  - why it is useful,
  - example use case.
- Feedback is text-only in v1.

## Credits and billing

Both medical and nutrition use a shared credit system per account/user.

Credit behavior:

- Show available credits.
- Show free and paid credit balances.
- Show recent credit movements.
- Show media usage: images today and audio minutes this week when relevant.
- Show top-up packs.
- Provide a top-up flow.
- If an action requires more credits than available, show the required amount, available amount, and how to recharge.

Do not make credits the central experience. It is a utility area.

## Media and input types

The app should support:

- Text input.
- Camera capture.
- Photo upload.
- PDF/document upload.
- Screenshot upload.
- Audio may exist in the underlying system, but do not make audio a primary design requirement unless it naturally fits.

Medical media:

- Studies, lab results, prescriptions, epicrisis, symptom photos, monitoring screenshots.

Nutrition media:

- Food photos.
- Nutrition label photos.
- Scale photos/screenshots.

## Important states to design

Please include mobile screens or states for:

- Empty account / first profile onboarding.
- Profile switcher.
- Profile home with both medical and nutrition summary.
- No medical episodes yet.
- Active episode exists.
- No nutrition logs today.
- Food logged successfully.
- Ambiguous delete/modify target.
- Low credit or insufficient credit.
- Upload in progress.
- Analysis in progress.
- Medical urgency warning.
- Data confidence / estimated nutrition values.
- Feedback saved.
- Privacy/disclaimer moment.

## Compliance and trust

The app must clearly communicate:

- It is an assistant for education, organization, and preparation.
- It does not replace professional medical advice.
- It does not diagnose, treat, cure, or prevent medical conditions.
- Users should consult a healthcare professional for medical decisions.
- Urgent warning states should be prominent and action-oriented.
- Sensitive health data should feel private and controlled.

Avoid fear-based UI. Avoid exaggerated medical claims.

## Desired Stitch output

Generate a high-fidelity mobile app concept with enough screens to understand the complete product, including:

- Onboarding.
- Profile creation and switching.
- Profile home.
- Nutrition registration flow.
- Nutrition summary/statistics.
- Nutrition learning/tutorial flow.
- Medical consultation flow.
- Medical document upload/interpretation flow.
- Medical history timeline.
- Consultation prep.
- Follow-up list/update.
- Credits and top-up.
- Help/feedback.
- Settings.

Please propose the visual direction, layout, navigation pattern, screen grouping, and component hierarchy yourself. Do not ask me to choose the UI style first.
```

