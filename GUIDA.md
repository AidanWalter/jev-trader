# Guida semplice a Jev Trader

Questa guida spiega il programma con parole normali, senza gergo. Il README originale (in inglese)
resta la fonte tecnica.

## Cosa fa, in parole povere

Su Monad esistono dei "blocchi": sono come i battiti di un orologio, uno ogni ~0,3 secondi. Dentro
ogni battito il programma fa quattro cose:

1. **Guarda i prezzi.** Chiede alla blockchain com'è messo il listino di scambio tra MON e USDC sul
   mercato Kuru: chi vuole vendere a quanto, chi vuole comprare a quanto.
2. **Chiede un parere alla intelligenza artificiale (Jev).** Le manda il riassunto del listino e le
   chiede una cosa sola: tra un po' il prezzo sarà più alto o più basso?
3. **Mette un annuncio.** Scrive sulla blockchain un ordine vero: "compro 200 MON a questo prezzo"
   oppure "vendo 200 MON a questo prezzo". Nello stesso momento cancella l'annuncio del battito
   precedente, così non si accumulano.
4. **Segna cosa è successo** e lo manda alla dashboard, che è la pagina web che stai guardando.

L'annuncio non "attacca" il mercato: si mette in fila e aspetta. Se qualcuno lo prende, hai fatto uno
scambio (un "fill"). È per questo che il programma guadagna lo scarto tra il prezzo di acquisto e
quello di vendita invece di pagarlo.

## Differenza tra prova e soldi veri

- **Prova (dry run):** legge prezzi veri e Jev decide davvero, ma nessun ordine viene scritto sulla
  blockchain e nessun soldo si muove. Gli scambi sono simulati. È la modalità impostata adesso.
- **Soldi veri (live):** serve una chiave privata di un portafoglio con dentro MON (per le spese di
  rete) e USDC (per comprare). Gli ordini finiscono davvero sul mercato.

La modalità dipende dal file `.env`: se `PRIVATE_KEY` è vuota, è sempre una prova.

## Come si accende

Serve Bun (già installato).

```powershell
# 1. il cervello: legge il mercato e decide
cd C:\Users\zinga\Desktop\dev\Jev_Trade
bun run src/index.ts          # ascolta su http://localhost:3100

# 2. la dashboard: la pagina da guardare
cd web
bun x next dev -p 3200        # apri http://localhost:3200
```

Per fermarli: `Ctrl+C` nella finestra dove stanno girando.

Nota: la porta 3000 di solito è occupata da altri progetti, per questo si usa 3100 per il cervello e
3200 per la dashboard. La dashboard sa dove trovare il cervello grazie a `web/.env.local`.

## Cosa significano i numeri sullo schermo

| Voce | Significato |
| --- | --- |
| **Block** | il numero del battito dell'orologio. Sale da solo, uno ogni ~0,3 s. |
| **buy % / sell %** | quanto Jev è convinto di una direzione. 100% = sicurissimo, 50% = indeciso. |
| **latency** | quanto ci ha messo Jev a rispondere, in millisecondi. |
| **late** | il battito è passato mentre Jev stava ancora pensando: quel giro non si è fatto nulla. |
| **spread** | la distanza tra il prezzo più basso a cui qualcuno vende e il più alto a cui qualcuno compra. È il guadagno massimo teorico di uno scambio. |
| **fills** | quante volte qualcuno ha preso uno dei nostri annunci. |
| **gas** | la spesa di rete per scrivere sulla blockchain. Si paga a ogni battito in cui si mette un ordine. |
| **P&L** | guadagno o perdita totale, in dollari. In prova è simulato e va letto con prudenza. |
| **capped** | la decisione di Jev non si poteva eseguire (troppa merce in casa o soldi finiti), quindi si è fatto il contrario per rientrare. |

## Le tre cose da sapere sui costi

1. **Il gas si paga a ogni battito**, non solo quando si guadagna: circa 0,036 MON per ordine, cioè
   qualche dollaro all'ora di bot acceso.
2. **Il guadagno per scambio è piccolo**: con lo spread attuale (circa 3,5 bps) uno scambio completo
   in entrambe le direzioni rende meno di quello che costa il gas dei due battiti necessari.
3. Per questo, con pochi soldi, il verdetto è: **si impara molto, non si guadagna**. Il programma è
   nato per mostrare che un'AI può decidere e far muovere denaro vero ogni 0,3 secondi, non per
   essere redditizio così com'è.

## Se qualcosa va storto

**Il processo si chiude mentre c'è un ordine sul mercato.** L'ordine resta lì e tiene bloccata una
parte dei soldi nel conto margin. Alla ripartenza il programma ora se ne accorge da solo: legge la
lista salvata in `data/open-orders.json`, controlla sulla blockchain quali ordini sono ancora aperti
e li cancella prima di ricominciare. Se la cancellazione fallisce, la lista resta nel file e ci
riprova al giro dopo.

**Voglio cancellare tutto a mano.** Gli ordini aperti si vedono e si cancellano dal sito di Kuru
collegando lo stesso portafoglio. Il collaterale si ritira con la funzione `withdraw` del contratto
MarginAccount: i soldi non sono persi, sono solo bloccati finché c'è un ordine aperto.

**Un ordine risulta "lost".** Vuol dire che non è arrivata la conferma entro 10 battiti. Nella
maggior parte dei casi la transazione non è mai passata. In un caso raro può arrivare in ritardo e in
quel caso l'ordine esiste ma il programma non ne conosce il numero: si controlla a mano dal sito.

## Prima di usare soldi veri

1. Crea un **portafoglio nuovo e dedicato**, mai quello principale, e mettici solo quello che sei
   disposto a perdere.
2. Ti servono **MON** (per il gas e per gli ordini di vendita) e **USDC** (per gli ordini di
   acquisto) sulla rete Monad.
3. Imposta in `.env` dei limiti piccoli: `TRADE_SIZE_MON=200` (il minimo del mercato),
   `MAX_POSITION_MON=400`, `MARGIN_MON=200`, `MARGIN_USDC=5`.
4. Fai una sessione breve, un quarto d'ora, con un obiettivo preciso: verificare che gli ordini
   arrivino davvero sul mercato, che gli scambi arrivino, e che alla chiusura non resti niente di
   appeso. Non aspettarti guadagni.
5. Tieni `DRY_RUN=true` finché non hai finito di leggere questa guida.

## Gli strumenti di misura già pronti

```powershell
bun run scripts/bench-jev.ts          # quanto è veloce Jev e quanto costa per risposta
bun run scripts/score-decisions.ts    # guarda le decisioni passate e dice quante hanno indovinato
bun run scripts/trades-smoke.ts       # quanti scambi ci sono stati sul mercato nell'ultima ora
bun run scripts/bench-read.ts         # quanto ci mette a leggere i prezzi
```

`score-decisions.ts` è il più importante: dice se Jev ha davvero fiuto o se sta tirando a indovinare.
Finché quel numero non è buono, nessuna somma di denaro ha senso investirci.
