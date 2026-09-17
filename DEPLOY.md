# Mettere il bot su un server, spiegato semplice

## Perché serve

Il bot ha 300 millisecondi di tempo per ogni battito. La risposta di Jev viaggia fino ai suoi
computer, che stanno in America, e torna indietro: **185 millisecondi sono solo di viaggio**. Da casa
tua il conto è 185 di viaggio + ~100 di calcolo = circa 280 ms, e il battito dura 300: siamo sempre
all'ultimo istante e il 41% dei battiti salta.

Se il bot gira su un computer in America, vicino a Jev, il viaggio quasi sparisce: si scende intorno
ai 130 ms e i battiti saltati diventano rari. È l'unica modifica che cambia davvero i numeri.

Non serve scrivere codice: la cartella ha già il `Dockerfile`, cioè la ricetta che dice a un computer
come avviare il programma. Serve solo noleggiare un computer e consegnargli la ricetta.

## Cosa ti serve

- il codice su GitHub (è già lì)
- un account su Railway (il più semplice) oppure su Fly.io, Render, o un server tuo
- la chiave di Jev

## Passi con Railway (i più facili)

1. Vai su railway.app e accedi con GitHub.
2. `New Project` → `Deploy from GitHub repo` → scegli `jev-trader`.
3. Railway trova il `Dockerfile` da solo, grazie al file `railway.json` incluso qui.
4. In `Settings` → `Variables` aggiungi:

   | Nome | Valore |
   | --- | --- |
   | `MODEL` | `jev` |
   | `TYPESAFE_AI_API_KEY` | la tua chiave |
   | `DRY_RUN` | `true` per ora (prova, nessun soldo) |
   | `RPC_URL` | `https://rpc.monad.xyz` |
   | `READ_RPC_URL` | `https://rpc.monad.xyz` |
   | `WS_URL` | `wss://rpc.monad.xyz` |
   | `TRADE_SIZE_MON` | `200` |
   | `MAX_POSITION_MON` | `400` |

   **Non impostare `PORT`**: lo decide Railway da solo e il programma lo legge.

   Railway ha un pulsante `Raw Editor` dove si incolla tutto in una volta. Copia queste righe e
   sostituisci solo `incolla_qui_la_tua_chiave`:

   ```
   MODEL=jev
   DRY_RUN=true
   TYPESAFE_AI_API_KEY=incolla_qui_la_tua_chiave
   RPC_URL=https://rpc.monad.xyz
   READ_RPC_URL=https://rpc.monad.xyz
   WS_URL=wss://rpc.monad.xyz
   TRADE_SIZE_MON=200
   MAX_POSITION_MON=400
   MARGIN_MON=200
   MARGIN_USDC=5
   ```

5. In `Settings` → `Region` scegli **US East (Virginia)**. È la scelta che fa la differenza.
6. `Deploy` e guarda i log: deve comparire la riga
   `jev-trader · model=jev-latest · ... DRY RUN · ...`

## Come capire se è servito

- nei log c'è `loop XXXms`: da casa tua sta fra 330 e 700, sul server deve stare sotto 300
- sulla dashboard le righe gialle `LATE` devono diventare rare
- aprendo l'indirizzo del servizio nel browser deve rispondere con un blocco di testo JSON

## La dashboard

La dashboard è un secondo programma (cartella `web/`) e va messa online a parte, per esempio su
Vercel:

1. Vercel → `Add New Project` → importa lo stesso repository
2. nella configurazione metti come `Root Directory` la cartella `web`
3. aggiungi la variabile `NEXT_PUBLIC_API_URL` con l'indirizzo del backend su Railway, per esempio
   `https://jev-trader-production.up.railway.app`
4. dopo il deploy apri l'indirizzo che ti dà Vercel

## Quanto costa

- **server**: pochi euro al mese (Railway parte da circa 5 dollari)
- **Jev**: circa 0,80 dollari per ogni ora in cui decide a ogni battito
- **gas** (solo con soldi veri): altri 5-10 dollari all'ora

Il bot acceso ventiquattr'ore su ventiquattro consuma credito Jev anche quando il mercato è fermo.
Se lo usi per guardarlo, accendilo quando serve e spegnilo dopo.

## Se non vuoi noleggiare niente

Resta tutto come adesso: il 41% dei battiti si perde, ma il programma funziona, si vede tutto e non
costa nulla. È la modalità giusta finché stai studiando.
