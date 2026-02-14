# LLM Feedback

Lokalne narzędzie do zbierania feedbacku UI z Chrome.

Aktualny workflow:
- rysujesz prostokątne obszary na stronie,
- do każdego dodajesz notatkę,
- wysyłasz raport do lokalnego backendu,
- backend zapisuje `JSON + Markdown`.
- na stronie widzisz pływającą ikonę `UI` (prawy dolny róg), która otwiera panel opcji.

Bez chmury pośredniej.

## Wymagania

- Chrome
- Node.js

## Struktura

- `extension/` - rozszerzenie MV3
- `backend/` - backend localhost (`POST /analyze`)
- `backend/reports/` - raporty

## 1) Uruchom backend

```bash
cd backend
npm start
```

Health check:
```bash
curl http://127.0.0.1:3030/health
```

## 2) Załaduj rozszerzenie

1. Otwórz `chrome://extensions`.
2. Włącz `Developer mode`.
3. Kliknij `Load unpacked`.
4. Wybierz katalog `extension/`.

## 3) Jak używać

1. Otwórz stronę, którą chcesz zgłaszać.
2. Na stronie kliknij pływającą ikonę `UI` (prawy dolny róg).
3. W panelu kliknij `Zaznacz obszar` albo `Wybierz element`.
4. Na stronie narysuj myszką prostokąt (drag and drop).
5. Dodaj notatkę:
   - przez `N` przy obszarze (inline), albo
   - przez popup rozszerzenia.
6. Powtórz kroki 3-5 tyle razy, ile obszarów chcesz dodać.
7. W panelu `UI` opcjonalnie wpisz nazwę w polu `Nazwa pliku (opcjonalnie)`.
8. Kliknij `Zapisz plik` (w panelu pojawią się ścieżki `JSON/MD`; kliknięcie ścieżki kopiuje ją do schowka).

Usuwanie obszaru:
- przy każdym narysowanym obszarze jest przycisk `×`; kliknięcie usuwa obszar i powiązane z nim notatki z bieżącej sesji.

Notatka bez popupu:
- obok `×` jest przycisk `N`; otwiera pole tekstowe przy obszarze i zapisuje notatkę bezpośrednio na stronie.

Wybór elementu DOM:
- użyj `Wybierz element`, kliknij konkretny tag na stronie,
- narzędzie zapisze selektor, treść tekstową i HTML elementu (zawartość elementu) oraz `rect`, a potem utworzy zaznaczenie z notatką.

Wyczyść:
- w panelu `UI` przycisk `Wyczyść` resetuje bieżącą sesję (obszary, notatki, timeline) i zostawia pusty stan do dalszej pracy.

Pozycja panelu:
- w panelu wybierz jedną z pozycji: prawy dolny, prawy górny, lewy dolny, lewy górny,
- ikona `UI` i panel przestawiają się razem.

Scroll lock panelu:
- gdy panel `UI` jest otwarty, scroll strony jest domyślnie zablokowany,
- przycisk `SB: ON/OFF` w panelu przełącza blokadę scrolla.

Rejestrowanie zdarzeń i logów:
- przycisk `Rejestruj zdarzenia i logi konsoli` w panelu włącza śledzenie kroków użytkownika i logów (`console`, `network`, `js`),
- po włączeniu odtwórz kroki do problemu, potem zapisz raport,
- aby ograniczyć rozmiar raportu, wpisy z pól tekstowych są logowane jako stabilna zmiana (`change`), a nie każdy znak.

Uwaga o nazwie pliku:
- jeśli wpisana nazwa pliku nie jest używana, najczęściej działa stara wersja backendu; uruchom ponownie `npm start` w `backend/`.

Dodatkowo:
- w popupie możesz nadal użyć `Wyślij do localhost`,
- `Export JSON` zapisuje raport lokalnie, gdy backend nie działa.

## Co jest w raporcie

- timeline działań (`click`, `input`, `scroll`, `nav`, błędy JS/network)
- lista zaznaczonych obszarów (`regions`)
- notatki przypięte do obszarów (`annotations`)
- dane sesji

## Konfiguracja zapisu

Plik: `backend/config.json`

Najważniejsze pole:
- `outputDir` - katalog raportów

## Prywatność

Maskowane są:
- pola hasła,
- tokeny i sekrety zgodne z regexami w `sensitivePatterns`.
