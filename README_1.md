# Tablet Dimmer voor Home Assistant

Dimt je wandtablet automatisch zodra het dashboard fullscreen draait.

| Stand    | Wat er gebeurt |
|----------|----------------|
| Ochtend  | Gedimde helderheid, of er iemand thuis is of niet |
| Dag      | Normale helderheid als er iemand thuis is, lager als niemand thuis is |
| Avond    | Gedimde helderheid, of er iemand thuis is of niet |
| Slaap    | Zwart scherm met alleen de tijd (of helemaal zwart) |

In de slaapstand wordt de tablet bij aanraken tijdelijk wakker in de ochtend- of avondstand. Na het ingestelde aantal minuten zonder aanraking gaat hij terug naar de slaapstand. De eerste tik maakt het scherm alleen wakker en klikt niets aan op het dashboard.

## Installatie via HACS

1. Zet deze map in een eigen GitHub-repository (bijvoorbeeld `tablet-dimmer`).
2. Ga in Home Assistant naar **HACS → ⋮ → Custom repositories**.
3. Plak de URL van je repository en kies als type **Dashboard**.
4. Installeer **Tablet Dimmer** en herlaad de browser (op de tablet ook).

## Handmatige installatie

1. Kopieer `tablet-dimmer.js` naar `/config/www/`.
2. Ga naar **Instellingen → Dashboards → ⋮ → Resources** en voeg toe: `/local/tablet-dimmer.js` als *JavaScript module*.

## Toevoegen aan het dashboard

Voeg een kaart toe via **Handmatig** en plak:

```yaml
type: custom:tablet-dimmer-card
presence_entity: zone.home      # of person.peter / group.gezin
fullscreen_only: true
wake_mode: auto                 # auto = voor 12:00 ochtend, daarna avond
wake_timeout: 2                 # minuten wakker na aanraken
sleep_style: clock              # clock of black
clock_brightness: 35            # zichtbaarheid van de klok in %
show_date: true
show_card: false                # true = statuskaart met knoppen tonen
modes:
  morning:
    start: "06:30"
    brightness: 60
  day:
    start: "09:00"
    brightness: 100
    brightness_away: 40         # als niemand thuis is
  evening:
    start: "19:00"
    brightness: 35
  sleep:
    start: "23:00"
    brightness: 5
```

Zet de kaart op de view die de tablet als eerste opent. Wissel je daarna van view, dan blijft de dimmer gewoon doorwerken tot je de pagina herlaadt.

Elke stand kan ook een `brightness_away` krijgen. Een stand overslaan doe je met `enabled: false`.

## Wanneer is hij actief?

Alleen in fullscreen, tenzij je `fullscreen_only: false` zet. Fullscreen wordt herkend bij:

- Fully Kiosk Browser
- Browser in fullscreen (F11) of kiosk-modus
- De Home Assistant-app of een geïnstalleerde web-app (standalone)
- Een URL met `?kiosk` of `?td_active`

## Echte schermhelderheid met Fully Kiosk

In een gewone browser legt de dimmer een zwarte laag over het dashboard. Dat oogt donkerder, maar de achtergrondverlichting blijft branden. Met Fully Kiosk Browser stuurt de dimmer de echte schermhelderheid aan:

1. Open Fully Kiosk → **Settings → Advanced Web Settings**.
2. Zet **Enable JavaScript Interface** aan.
3. Herlaad het dashboard. De statuskaart toont dan *Aansturing: Fully Kiosk (scherm)*.

Zet in Fully Kiosk de eigen screensaver en "screen off timer" uit, anders lopen die door de slaapstand heen.

## Problemen oplossen

- **Er gebeurt niets:** zet `show_card: true` en kijk wat de statuskaart zegt. Staat er *Wacht op fullscreen*, dan wordt fullscreen niet herkend; voeg `?td_active` aan de URL toe of zet `fullscreen_only: false`.
- **Aanwezigheid klopt niet:** controleer in Ontwikkelhulpmiddelen de status van je `presence_entity`. `home`, `on` of een getal groter dan 0 telt als thuis.
