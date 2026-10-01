import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown,
  AtSign, BarChart3, Clock, Hash, Languages, Loader2, Lock, Mic, Paperclip,
  Send, Smile, Sparkles, Wand2, X,
} from 'lucide-react';
import type { Attachment, RewriteTone } from '@stellium/shared';
import { normalizeLang } from '@stellium/shared';
import { useStore, waitForMessageId } from '../state/store.js';
import { socket } from '../net/socket.js';
import { useFokusfalle } from './Fokusfalle.jsx';
import { spracheName, useT, t } from '../i18n/index.js';
import { api } from '../net/api.js';
import { EmojiPicker } from './EmojiPicker.jsx';
import { Avatar } from './Avatar.jsx';
import { VoiceRecorder } from './VoiceRecorder.jsx';
import { clsx, fileSize, languageInfo, restzeit } from '../lib/format.js';
import { bildVerkleinern } from '../lib/bilder.js';
import { dateiVerschluesseln, kanalHuelle } from '../lib/vertraulich.js';

interface Props {
  channelId: string;
  parentId?: string | null;
  placeholder?: string;
  autoFocus?: boolean;
}

type PendingAttachment = Pick<Attachment, 'id' | 'name' | 'mime' | 'size'> & {
  progress: number;
  /** Wie viele Bytes das Verkleinern gespart hat. */
  gespart?: number;
  /** Wie schnell es gerade läuft, in Byte pro Sekunde. */
  tempo?: number;
  /** Geschätzte Restzeit in Sekunden. */
  rest?: number;
};

/* Nur die Kennungen — die Beschriftung kommt aus dem Wörterbuch. */
const TONES: RewriteTone[] = ['polish', 'formal', 'friendly', 'concise', 'bullets'];

export function Composer({ channelId, parentId = null, placeholder, autoFocus }: Props) {
  const t = useT();
  const self = useStore((s) => s.self);
  const channel = useStore((s) => s.channels[channelId]);
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const ai = useStore((s) => s.ai);
  const smartReplies = useStore((s) => s.smartReplies);
  const smartRepliesLoading = useStore((s) => s.smartRepliesLoading);

  const [text, setText] = useState('');
  const [tastaturOffen, setTastaturOffen] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const emojiKnopf = useRef<HTMLButtonElement>(null);
  const [toneOpen, setToneOpen] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // Zwei Vervollständigungen teilen sich eine Liste: @ für Personen, # für Kanäle.
  const [autoArt, setAutoArt] = useState<'person' | 'kanal' | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [recording, setRecording] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /**
   * Welcher Anhang zu welcher schon verschickten Nachricht gehört.
   *
   * Wird beim Absenden befüllt (siehe submit()): alles, was zu dem Zeitpunkt
   * noch hochlädt, bekommt hier seine `clientId` hinterlegt. Wird der Upload
   * danach fertig — oder scheitert er —, findet einzeln() über diese Karte
   * heraus, ob noch ein normaler Composer-Anhang gemeint ist (Karte leer) oder
   * eine Nachricht, die längst unterwegs ist (Kennung vorhanden), und meldet
   * es im zweiten Fall über message:attach / message:attachGiveUp nach.
   */
  const unterwegs = useRef<Map<string, string>>(new Map());

  /**
   * Die echte Kennung einer gesendeten Nachricht abwarten — höchstens einmal
   * pro `clientId`, nicht bei jedem Aufruf neu.
   *
   * waitForMessageId() (state/store.ts) hört auf GENAU EIN message:new — das
   * eigene Echo der gerade gesendeten Nachricht. Dieses Echo kommt fast immer,
   * bevor ein gleichzeitig laufender Upload überhaupt fertig ist: submit()
   * unten schickt die Nachricht sofort hinaus, der Server antwortet binnen
   * Millisekunden, ein Bild braucht oft Sekunden bis Minuten. Wer erst NACH
   * dem Upload auf die Kennung wartet, ruft waitForMessageId() für ein
   * message:new auf, das längst durch war: settle() in store.ts wirkt nur
   * auf wer in diesem Moment zuhört, nichts spielt das Ereignis nach. Ohne
   * Zuhörer ist der Wert für immer weg, und der späte Aufruf wartet die volle
   * Frist (60 s) auf ein Echo, das nie wieder kommt — genau der Anhang, der
   * für immer „wird hochgeladen" zeigt, obwohl der Upload selbst längst fertig
   * war (oder sauber gescheitert ist).
   *
   * Deshalb hier: EIN Aufruf pro clientId, ausgelöst in submit() im selben
   * synchronen Durchlauf, der auch sendMessage() aufruft — also garantiert,
   * bevor irgendeine Antwort vom Server überhaupt eintreffen kann. Alles, was
   * die Kennung später braucht (mehrere Anhänge an derselben Nachricht
   * eingeschlossen), teilt sich dasselbe, längst wartende Versprechen.
   */
  const nachrichtKennung = useRef<Map<string, Promise<string>>>(new Map());
  const kennungAbwarten = (clientId: string): Promise<string> => {
    let wartend = nachrichtKennung.current.get(clientId);
    if (!wartend) {
      wartend = waitForMessageId(clientId);
      nachrichtKennung.current.set(clientId, wartend);
    }
    return wartend;
  };

  /* Höhe automatisch an den Inhalt anpassen */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    /* Nur mit Inhalt eine feste Höhe setzen. Leer bleibt sie `auto`, damit
       der Kasten genau so hoch ist wie seine eine Zeile — ein auch nur um
       Bruchteile gestreckter Kasten setzt in WebKit den Schreibcursor an
       den Rahmen statt an den Innenabstand (siehe mobil.css). */
    if (text) el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);

  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus, channelId]);

  // Beim Kanalwechsel den gespeicherten Entwurf zurückholen.
  useEffect(() => {
    setText(useStore.getState().draftFor(channelId, parentId));
    setPreview(null);
  }, [channelId, parentId]);

  /* Compose-Vorschau: so kommt die Nachricht bei den anderen an.
     Die Sprache hing allein an der Kanalsprache — die ist in einer
     Direktnachricht aber nicht gesetzt, und dort gab es deshalb nie eine
     Vorschau. Gefragt ist ohnehin die Sprache der Gegenseite. */
  const zielsprache = (): string | null => {
    if (!channel || !self) return null;
    const meine = normalizeLang(self.language);

    if (channel.kind === 'dm') {
      const gegenueber = users[channel.dmPeerId ?? ''];
      const seine = gegenueber?.language ? normalizeLang(gegenueber.language) : null;
      return seine && seine !== meine ? seine : null;
    }

    if (channel.primaryLanguage) {
      const kanal = normalizeLang(channel.primaryLanguage);
      return kanal !== meine ? kanal : null;
    }

    /* Ohne festgelegte Kanalsprache die häufigste unter den anderen nehmen —
       besser eine Vorschau in der Sprache der Mehrheit als keine. */
    const zaehler = new Map<string, number>();
    for (const id of channel.memberIds) {
      if (id === self.id) continue;
      const sprache = users[id]?.language ? normalizeLang(users[id].language) : null;
      if (!sprache || sprache === meine) continue;
      zaehler.set(sprache, (zaehler.get(sprache) ?? 0) + 1);
    }
    return [...zaehler.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };

  const targetLang = zielsprache();
  /* In einem vertraulichen Kanal fällt alles weg, was den Text zum Server
     bringt: Vorschau, Umformulieren, Umfrage und Sprachnachricht. Die ersten
     beiden schickten Klartext an ein fremdes Modell, die letzten beiden
     schrieben ihn offen in einen Kanal, den jemand ausdrücklich geschlossen
     hat. Der Server weist das ab — die Knöpfe gar nicht erst anzubieten ist
     der ehrlichere Weg. */
  const vertraulich = Boolean(channel?.vertraulich);
  const needsPreview = Boolean(self?.composeTargetPreview && targetLang && ai?.translation && !vertraulich);

  /* Zählt jede Änderung am Text mit. Eine Vorschau, die erst nach dem
     Absenden ankam, stand sonst unter dem leeren Feld — oder die zu einem
     älteren Stand überschrieb die neuere. */
  const vorschauNr = useRef(0);
  useEffect(() => {
    const nr = ++vorschauNr.current;
    // Vier Zeichen: "okay" soll man sich ansehen können, ein "o" nicht.
    if (!needsPreview || text.trim().length < 4) { setPreview(null); setPreviewing(false); return; }
    const timer = window.setTimeout(() => {
      setPreviewing(true);
      useStore.getState().composePreview(text, targetLang!, channelId)
        .then((result) => { if (nr === vorschauNr.current) setPreview(result); })
        .catch(() => { if (nr === vorschauNr.current) setPreview(null); })
        .finally(() => { if (nr === vorschauNr.current) setPreviewing(false); });
    }, 900);
    return () => clearTimeout(timer);
  }, [text, needsPreview, targetLang, channelId]);

  /* @-Vervollständigung */
  const refreshMentionQuery = useCallback(() => {
    const el = inputRef.current;
    if (!el) { setMentionQuery(null); setAutoArt(null); return; }
    const upToCaret = el.value.slice(0, el.selectionStart ?? el.value.length);

    const person = /(?:^|\s)@([a-zA-Z0-9_.-]*)$/.exec(upToCaret);
    if (person) {
      setAutoArt('person');
      setMentionQuery(person[1].toLowerCase());
      setMentionIndex(0);
      return;
    }

    // Kanalnamen dürfen Umlaute enthalten, deshalb hier großzügiger als bei @.
    const kanal = /(?:^|\s)#([\p{L}\p{N}_-]*)$/u.exec(upToCaret);
    if (kanal) {
      setAutoArt('kanal');
      setMentionQuery(kanal[1].toLowerCase());
      setMentionIndex(0);
      return;
    }

    setAutoArt(null);
    setMentionQuery(null);
  }, []);

  useEffect(() => { refreshMentionQuery(); }, [text, refreshMentionQuery]);

  const personMatches = autoArt !== 'person' || mentionQuery === null ? [] : Object.values(users)
    // Gesperrte und gelöschte Konten kann man nicht sinnvoll erwähnen —
    // sie bekommen die Benachrichtigung nie zu sehen.
    /* Technische Konten (Assistent, Wartung) sind nicht zu erwähnen: sie
       lesen nichts und können nicht antworten. */
    .filter((u) => u.id !== self?.id && u.role !== 'bot' && !u.disabled && !u.technisch)
    .filter((u) => u.handle.toLowerCase().startsWith(mentionQuery) || u.displayName.toLowerCase().includes(mentionQuery))
    .slice(0, 6);

  const kanalMatches = autoArt !== 'kanal' || mentionQuery === null ? [] : Object.values(channels)
    .filter((c) => c.kind !== 'dm' && !c.archived)
    .filter((c) => c.name.toLowerCase().includes(mentionQuery))
    .sort((a, b) => {
      // Genaue Anfänge zuerst, dann alphabetisch.
      const aStart = a.name.toLowerCase().startsWith(mentionQuery) ? 0 : 1;
      const bStart = b.name.toLowerCase().startsWith(mentionQuery) ? 0 : 1;
      return aStart - bStart || a.name.localeCompare(b.name, 'de');
    })
    .slice(0, 8);

  const mentionMatches: { id: string; primaer: string; sekundaer: string; einsetzen: string }[] =
    autoArt === 'person'
      ? personMatches.map((u) => ({
          id: u.id, primaer: u.displayName,
          sekundaer: `@${u.handle} · ${languageInfo(u.language).flag}`,
          einsetzen: `@${u.handle}`,
        }))
      : kanalMatches.map((c) => ({
          id: c.id, primaer: `#${c.name}`,
          sekundaer: c.topic || (c.kind === 'private' ? t('channel.privateOne') : t('channel.publicOne')),
          einsetzen: `#${c.name}`,
        }));

  const applyMention = (einsetzen: string) => {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? text.length;
    const muster = autoArt === 'kanal' ? /#[\p{L}\p{N}_-]*$/u : /@[a-zA-Z0-9_.-]*$/;
    const before = text.slice(0, caret).replace(muster, `${einsetzen} `);
    const next = before + text.slice(caret);
    setText(next);
    useStore.getState().saveDraft(channelId, parentId, next);
    setMentionQuery(null);
    setAutoArt(null);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = before.length;
    });
  };

  /* Dateien */
  const uploadFiles = async (files: FileList | File[]) => {
    /* Mehrere Dateien gingen bisher eine nach der anderen — bei fünf Bildern
       wartete man fünfmal hintereinander. Drei gleichzeitig ist ein guter
       Kompromiss: schneller, ohne die Leitung zu verstopfen. */
    const liste = Array.from(files);
    const GLEICHZEITIG = 3;

    /**
     * Einen Anhang aufgeben — der Upload ist gescheitert, oder er ließ sich
     * gar nicht erst verschlüsseln.
     *
     * Drei Fälle, je nachdem, ob die Nachricht schon unterwegs war (siehe
     * `unterwegs` oben an der Komponente): Läuft der Anhang noch im
     * Composer-Feld mit, genügt es, ihn dort wegzunehmen. Steht die Nachricht
     * schon, aber noch offline in der Warteschlange, wird der Platzhalter
     * dort direkt wieder herausgenommen (socket.patchQueuedMessage) — sonst
     * ginge er beim nächsten flush() als Zusage für eine Datei hinaus, die es
     * nie geben wird, und das für jede Person im Kanal, für immer. Steht die
     * Nachricht schon beim Server — weil senden inzwischen nicht mehr auf
     * einen Upload wartet —, muss der Server erfahren, dass aus dem
     * Platzhalter nichts wird (message:attachGiveUp), sonst zeigte die
     * Nachricht bei allen anderen für immer "wird hochgeladen".
     */
    const aufgeben = async (tempId: string, fehler: Error) => {
      setAttachments((prev) => prev.filter((a) => a.id !== tempId));
      useStore.getState().toast({ kind: 'error', title: t('composer.uploadFailed'), body: fehler.message });

      const zielClientId = unterwegs.current.get(tempId);
      if (!zielClientId) return;
      unterwegs.current.delete(tempId);
      const nochInWarteschlange = socket.patchQueuedMessage(zielClientId, (ev) => {
        ev.pendingAttachments = ev.pendingAttachments?.filter((p) => p.tempId !== tempId);
      });
      // Stand die Nachricht noch offline in der Warteschlange, ist sie damit
      // schon korrigiert — der Server hat noch gar keine Kennung für sie
      // vergeben, ein message:attachGiveUp liefe also ins Leere.
      if (nochInWarteschlange) return;
      try {
        const messageId = await kennungAbwarten(zielClientId);
        useStore.getState().giveUpAttachment(messageId, tempId);
      } catch {
        // Die Nachricht kam nie durch (siehe waitForMessageId-Frist) — dann
        // gibt es auch nichts, wovon man den Anhang wieder abmelden müsste.
      }
    };

    const einzeln = async (roh: File) => {
      const temp: PendingAttachment = {
        id: `tmp_${Math.random()}`, name: roh.name, mime: roh.type, size: roh.size, progress: 0,
      };
      setAttachments((prev) => [...prev, temp]);

      /* Erst kleiner machen, dann hochladen. Bei einem Foto vom Telefon ist
         das der Unterschied zwischen vier Megabyte und vierhundert Kilobyte —
         daran hängt beim Hochladen mehr als an jedem Übertragungstrick. */
      const { datei: verkleinert, vorher, nachher } = await bildVerkleinern(roh);
      if (nachher < vorher) {
        setAttachments((prev) => prev.map((a) => a.id === temp.id
          ? { ...a, size: nachher, mime: verkleinert.type, gespart: vorher - nachher }
          : a));
      }

      /* In einem vertraulichen Kanal geht die Datei nur verschlossen hinaus.
         Der Schlüssel dafür gehört zum Kanal, nicht zum Inhalt — wer die
         Nachrichten liest, liest auch die Bilder darin.

         Verkleinern zuerst, verschlüsseln danach: umgekehrt bekäme der
         Bildkodierer Chiffrat vorgesetzt und richtete nichts aus. Und der
         Verlust ist keiner — was hinausgeht, ist ohnehin nur das, was der
         Kanal sehen soll.

         Name und Typ werden neutral. Sie stehen verschlossen im Umschlag der
         Datei; auf dem Server soll "Kündigung Meier.pdf" nicht danebenstehen
         und den Inhalt verraten, ohne dass jemand ihn öffnen müsste. */
      let file = verkleinert;
      if (vertraulich) {
        try {
          const zu = await dateiVerschluesseln(verkleinert, kanalHuelle(channelId));
          file = new File([zu], 'verschlossen', { type: 'application/octet-stream' });
        } catch (err) {
          await aufgeben(temp.id, err as Error);
          return;
        }
      }

      /* Tempo über ein gleitendes Fenster: der Momentanwert springt zu stark,
         um ihn ablesen zu können. */
      const proben: { zeit: number; bytes: number }[] = [{ zeit: performance.now(), bytes: 0 }];

      try {
        const { attachment } = await api.uploadSchnell(file, (anteil, bytes) => {
          const jetzt = performance.now();
          proben.push({ zeit: jetzt, bytes });
          while (proben.length > 2 && jetzt - proben[0].zeit > 3000) proben.shift();
          const erste = proben[0];
          const sekunden = (jetzt - erste.zeit) / 1000;
          const tempo = sekunden > 0.25 ? (bytes - erste.bytes) / sekunden : undefined;
          const rest = tempo && tempo > 0 ? (file.size - bytes) / tempo : undefined;
          setAttachments((prev) => prev.map((a) => a.id === temp.id ? { ...a, progress: anteil, tempo, rest } : a));
        }, { verschluesselt: vertraulich });
        /* Der Name bleibt der ursprüngliche, nicht der neutrale vom Server:
           die Vorschau im Eingabefeld gehört der schreibenden Person, und die
           weiß ja, was sie angehängt hat. */
        setAttachments((prev) => prev.map((a) => a.id === temp.id
          ? { ...attachment, name: roh.name, mime: verkleinert.type || roh.type, progress: 1 }
          : a));

        /* Stand die Nachricht schon, als dieser Upload fertig wurde (siehe
           submit() und `unterwegs`), muss sie ihren Anhang jetzt nachträglich
           bekommen — sie wartet nicht auf uns, wir holen sie ein. */
        const zielClientId = unterwegs.current.get(temp.id);
        if (zielClientId) {
          unterwegs.current.delete(temp.id);
          /* Steht die Nachricht noch offline in der Warteschlange, lässt sich
             der Platzhalter direkt gegen die fertige Kennung tauschen — kein
             Rundweg über message:attach nötig, der zu dem Zeitpunkt ohnehin
             niemanden mehr erreicht (siehe kennungAbwarten-Frist im catch
             unten, und socket.ts, patchQueuedMessage). */
          const nochInWarteschlange = socket.patchQueuedMessage(zielClientId, (ev) => {
            ev.pendingAttachments = ev.pendingAttachments?.filter((p) => p.tempId !== temp.id);
            ev.attachmentIds = [...(ev.attachmentIds ?? []), attachment.id];
          });
          if (nochInWarteschlange) return;
          void (async () => {
            try {
              const messageId = await kennungAbwarten(zielClientId);
              useStore.getState().attachUploadToMessage(messageId, temp.id, attachment.id);
            } catch (fehler) {
              /* Die Nachricht kam nie durch (siehe waitForMessageId-Frist,
                 oder der Zweig "nicht verschlüsselbar" in sendMessage). Ohne
                 sie gibt es nichts, woran der Anhang hängen könnte — er bleibt
                 als eigenständige Zeile liegen (message_id NULL), genau wie
                 jeder Anhang, der hochgeladen und nie in eine Nachricht
                 aufgenommen wurde. Dafür gibt es heute keinen eigenen
                 Aufräumlauf — derselbe, seit je bestehende Zustand wie beim
                 Schließen der App mit einem angehängten, aber nie
                 abgeschickten Bild.

                 Der Upload selbst ist geglückt — nur das Nachtragen an die
                 Nachricht nicht. Das früher hier stehende console.error()
                 war für die schreibende Person unsichtbar: die Nachricht
                 zeigte weiter „wird hochgeladen", für immer, ohne jede
                 Erklärung. Jetzt bekommt sie denselben Hinweis wie bei jedem
                 anderen gescheiterten Anhang — mit dem Unterschied, dass hier
                 nichts wiederholt werden kann (der Platzhalter in der
                 Nachricht bleibt stehen, siehe Kommentar oben), aber
                 wenigstens steht fest, woran es lag, statt dass der Kreisel
                 kommentarlos ewig weiterdreht. */
              useStore.getState().toast({
                kind: 'error', title: t('composer.uploadFailed'), body: (fehler as Error).message,
              });
            }
          })();
        }
      } catch (err) {
        await aufgeben(temp.id, err as Error);
      }
    };

    let naechste = 0;
    const arbeiter = async () => {
      for (;;) {
        const i = naechste++;
        if (i >= liste.length) return;
        await einzeln(liste[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(GLEICHZEITIG, liste.length) }, arbeiter));
  };

  const submit = () => {
    const clean = text.trim();
    const ready = attachments.filter((a) => !a.id.startsWith('tmp_'));
    const pending = attachments.filter((a) => a.id.startsWith('tmp_'));
    if (!clean && ready.length === 0 && pending.length === 0) return;

    const command = handleSlashCommand(clean, channelId);
    if (command.handled) { setText(''); return; }

    /* Nicht mehr warten, bis der letzte Anhang oben ist: die Nachricht geht
       sofort hinaus, mit dem, was schon fertig ist. Was noch hochlädt, holt
       sie sich über message:attach nach, sobald es fertig ist — einzeln()
       findet die Nachricht über `unterwegs` wieder, sobald ihre echte
       Kennung feststeht (siehe waitForMessageId in state/store.ts). */
    const clientId = useStore.getState().sendMessage({
      channelId, text: command.replaceWith ?? clean, parentId,
      attachmentIds: ready.map((a) => a.id),
      pendingAttachments: pending.map((p) => ({ tempId: p.id, name: p.name, mime: p.mime })),
    });
    /* Auf das eigene message:new-Echo JETZT schon warten, nicht erst wenn
       ein Anhang fertig hochgeladen ist (siehe kennungAbwarten() oben) — das
       Echo kommt oft, bevor ein großes Bild überhaupt zur Hälfte oben ist,
       und ein späterer Aufruf verpasst es unwiderruflich. */
    if (pending.length) kennungAbwarten(clientId);
    for (const p of pending) unterwegs.current.set(p.id, clientId);

    setText('');
    setAttachments([]);
    setPreview(null);
    useStore.getState().saveDraft(channelId, parentId, '');
    useStore.getState().clearSmartReplies();
  };

  const applyTone = async (tone: RewriteTone) => {
    if (!text.trim()) return;
    setToneOpen(false);
    setRewriting(true);
    try {
      const result = await useStore.getState().rewrite(text, tone);
      setText(result);
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: t('toast.rewriteFailed'), body: (err as Error).message });
    } finally {
      setRewriting(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionMatches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMention(mentionMatches[mentionIndex].einsetzen); return; }
      if (e.key === 'Escape') { setMentionQuery(null); setAutoArt(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  const canSend = text.trim().length > 0 || attachments.length > 0;

  return (
    <div className="composer-wrap" data-tour="composer">
      <AnimatePresence>
        {/* Früher hing die Anzeige an {t('composer.empty')}. Wer die Vorschläge
            ausdrücklich anfordert, hat aber meist schon etwas getippt — dann
            kam nichts. Jetzt werden sie immer gezeigt und verschwinden erst,
            wenn wirklich weitergetippt wird. */}
        {smartReplies.length > 0 && (
          <motion.div
            className="smart-replies"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            style={{ padding: '0 0 var(--sp-2)' }}
          >
            {smartReplies.map((reply, i) => (
              <button
                key={i}
                className="smart-reply"
                onClick={() => {
                  setText(reply.text);
                  useStore.getState().saveDraft(channelId, parentId, reply.text);
                  useStore.getState().clearSmartReplies();
                  requestAnimationFrame(() => {
                    const el = inputRef.current;
                    if (!el) return;
                    el.focus();
                    el.selectionStart = el.selectionEnd = el.value.length;
                  });
                }}
              >
                <Sparkles size={12} className="spark" style={{ color: 'var(--violet-soft)' }} />
                {reply.text}
                <span className="smart-reply__tone">{reply.tone}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {recording && (
        <VoiceRecorder channelId={channelId} parentId={parentId} onDone={() => setRecording(false)} />
      )}

      <div
        className={clsx('composer', focused && 'composer--focus', dragging && 'composer--drag')}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
        }}
        style={{ position: 'relative', ...(recording ? { display: 'none' } : {}) }}
      >
        {parentId && (
          <div className="composer__reply">
            <span>{t('composer.replyingInThread')}</span>
            <button
              className="icon-btn icon-btn--sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => useStore.getState().openThread(null)}
              aria-label={t('common.close')}
            >
              <X size={13} />
            </button>
          </div>
        )}

        {attachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 14px 0' }}>
            {attachments.map((a) => (
              <div key={a.id} className="att-file" style={{ paddingRight: 8 }}>
                <div className="stack" style={{ minWidth: 0 }}>
                  <span className="att-file__name truncate" style={{ maxWidth: 180 }}>{a.name}</span>
                  <span className="att-file__size">
                    {a.progress < 1
                      ? [
                          `${Math.round(a.progress * 100)} %`,
                          // Tempo und Restzeit: dann sieht man, ob es hängt
                          // oder ob die Leitung einfach schmal ist.
                          a.tempo ? `${(a.tempo / 1048576).toFixed(1)} MB/s` : null,
                          a.rest && a.rest > 1 ? restzeit(a.rest) : null,
                        ].filter(Boolean).join(' · ')
                      : a.gespart
                        ? `${fileSize(a.size)} · ${t('composer.saved', { menge: fileSize(a.gespart) })}`
                        : fileSize(a.size)}
                  </span>
                  {a.progress < 1 && (
                    <span className="att-file__balken">
                      <span style={{ width: `${Math.round(a.progress * 100)}%` }} />
                    </span>
                  )}
                </div>
                <button
                  className="icon-btn icon-btn--sm"
                  onClick={() => setAttachments((p) => p.filter((x) => x.id !== a.id))}
                  aria-label={t('composer.attachmentEntfernen', { name: a.name })}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={inputRef}
          className="composer__input"
          rows={1}
          value={text}
          placeholder={placeholder ?? t('composer.placeholder', {
            target: channel?.kind === 'dm'
              ? users[channel.dmPeerId ?? '']?.displayName ?? '…'
              : `#${channel?.name ?? '…'}`,
          })}
          onChange={(e) => {
            setText(e.target.value);
            useStore.getState().sendTyping(channelId, parentId);
            useStore.getState().saveDraft(channelId, parentId, e.target.value);
            // Sobald jemand selbst formuliert, sind die Vorschläge erledigt.
            if (useStore.getState().smartReplies.length) useStore.getState().clearSmartReplies();
          }}
          onKeyDown={onKeyDown}
          onFocus={() => { setFocused(true); setTastaturOffen(true); }}
          onBlur={() => { setFocused(false); setTastaturOffen(false); }}
          onSelect={refreshMentionQuery}
          onClick={refreshMentionQuery}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) { e.preventDefault(); void uploadFiles(files); }
          }}
        />

        <div className="composer__bar">
          {/* Auf dem Telefon verdeckt die Tastatur den halben Bildschirm, und
              sie geht nur über eine Systemgeste wieder weg. Dieser Knopf
              erscheint erst beim Tippen und nimmt sonst keinen Platz. */}
          {tastaturOffen && (
            <button
              className="icon-btn icon-btn--sm nur-beruehrung"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => inputRef.current?.blur()}
              title={t('composer.hideKeyboard')}
              aria-label={t('composer.hideKeyboard')}
            >
              <ChevronDown size={16} />
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => { if (e.target.files) void uploadFiles(e.target.files); e.target.value = ''; }}
          />
          <button className="icon-btn icon-btn--sm" onClick={() => fileRef.current?.click()} title={t('composer.attach')} aria-label={t('composer.attach')}>
            <Paperclip size={16} />
          </button>
          <button
            ref={emojiKnopf}
            className="icon-btn icon-btn--sm"
            onClick={() => setPickerOpen(true)}
            title={t('composer.emoji')}
            aria-label={t('composer.emoji')}
          >
            <Smile size={16} />
          </button>
          <button
            className="icon-btn icon-btn--sm"
            onClick={() => {
              // Vor dem @ braucht es ein Leerzeichen, sonst greift die
              // Vervollständigung nicht — und der Cursor muss ans Ende.
              setText((t) => (t && !/\s$/.test(t) ? `${t} @` : `${t}@`));
              requestAnimationFrame(() => {
                const el = inputRef.current;
                if (!el) return;
                el.focus();
                el.selectionStart = el.selectionEnd = el.value.length;
              });
            }}
            title={t('composer.mention')}
            aria-label={t('composer.mention')}
          >
            <AtSign size={16} />
          </button>
          <button
            className="icon-btn icon-btn--sm"
            onClick={() => {
              setText((v) => (v && !/\s$/.test(v) ? `${v} #` : `${v}#`));
              requestAnimationFrame(() => {
                const el = inputRef.current;
                if (!el) return;
                el.focus();
                el.selectionStart = el.selectionEnd = el.value.length;
                refreshMentionQuery();
              });
            }}
            title={t('composer.channelLink')}
            aria-label={t('composer.channelLink')}
          >
            <Hash size={16} />
          </button>
          {!vertraulich && (
            <button
              className="icon-btn icon-btn--sm"
              onClick={() => setRecording(true)}
              title={t('composer.voice')}
              aria-label={t('composer.voice')}
            >
              <Mic size={16} />
            </button>
          )}
          {!parentId && !vertraulich && (
            <button
              className="icon-btn icon-btn--sm"
              onClick={() => useStore.getState().setOverlay('poll')}
              title={t('composer.poll')}
              aria-label={t('composer.poll')}
            >
              <BarChart3 size={16} />
            </button>
          )}

          {ai?.assistant && !vertraulich && (
            <div style={{ position: 'relative' }}>
              <button
                className="icon-btn icon-btn--sm"
                onClick={() => setToneOpen((v) => !v)}
                disabled={!text.trim() || rewriting}
                title={t('composer.rewrite')}
                aria-label={t('composer.rewrite')}
              >
                {rewriting ? <Loader2 size={16} className="spin" /> : <Wand2 size={16} />}
              </button>
              <AnimatePresence>
                {toneOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}
                    style={{
                      position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, zIndex: 20,
                      minWidth: 170, padding: 5, borderRadius: 'var(--r-md)',
                      background: 'var(--bg-elevated)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-md)',
                    }}
                    onMouseLeave={() => setToneOpen(false)}
                  >
                    {TONES.map((ton) => (
                      <button
                        key={ton}
                        onClick={() => void applyTone(ton)}
                        style={{ display: 'block', width: '100%', padding: '7px 10px', borderRadius: 6, textAlign: 'left', fontSize: 13.5 }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                      >{t(`tone.${ton}` as never)}</button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          <button
            className="icon-btn icon-btn--sm"
            onClick={() => setScheduleOpen(true)}
            disabled={!canSend}
            title={t('composer.scheduleLater')}
            aria-label={t('composer.scheduleLater')}
          >
            <Clock size={16} />
          </button>

          <span className="spacer" />

          {previewing && <Loader2 size={13} className="spin muted" />}
          <span className="muted" style={{ fontSize: 11.5, marginRight: 6 }}>
            {text.length > 0 && `${text.length}`}
          </span>

          <motion.button
            className="send-btn"
            whileTap={{ scale: 0.92 }}
            disabled={!canSend}
            onClick={submit}
            title={t('composer.send')}
            aria-label={t('composer.send')}
          >
            <Send size={16} />
          </motion.button>
        </div>

        <AnimatePresence>
          {pickerOpen && (
            <EmojiPicker
              ankerRef={emojiKnopf}
              onPick={(emoji) => { setText((t) => t + emoji); setPickerOpen(false); inputRef.current?.focus(); }}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {mentionMatches.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}
              style={{
                position: 'absolute', bottom: '100%', left: 12, marginBottom: 8, zIndex: 25,
                minWidth: 268, padding: 5, borderRadius: 'var(--r-md)',
                background: 'var(--bg-elevated)', border: '1px solid var(--line-strong)', boxShadow: 'var(--shadow-md)',
              }}
            >
              {mentionMatches.map((eintrag, i) => (
                <button
                  key={eintrag.id}
                  className="result"
                  data-active={i === mentionIndex}
                  style={{ padding: '6px 9px' }}
                  onMouseEnter={() => setMentionIndex(i)}
                  onClick={() => applyMention(eintrag.einsetzen)}
                >
                  {autoArt === 'person'
                    ? <Avatar user={users[eintrag.id]} size={26} showPresence />
                    : channels[eintrag.id]?.kind === 'private'
                      ? <Lock size={15} className="muted" style={{ width: 26, textAlign: 'center' }} />
                      : <Hash size={15} className="muted" style={{ width: 26, textAlign: 'center' }} />}
                  <div className="result__main">
                    <div className="result__title">{eintrag.primaer}</div>
                    <div className="result__sub">{eintrag.sekundaer}</div>
                  </div>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {preview && needsPreview && (
          <motion.div
            className="composer__preview"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <div className="composer__preview-head">
              <Languages size={11} />
              {t('composer.previewHead', { language: spracheName(targetLang!) })}
            </div>
            {preview}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {scheduleOpen && (
          <ScheduleDialog
            onClose={() => setScheduleOpen(false)}
            onPick={(sendAt) => {
              useStore.getState().schedule({ channelId, text: text.trim(), sendAt, parentId });
              setText('');
              // Wie nach dem Senden: sonst holte der nächste Kanalwechsel den
              // schon eingeplanten Text als Entwurf zurück.
              useStore.getState().saveDraft(channelId, parentId, '');
              setScheduleOpen(false);
              useStore.getState().toast({ kind: 'ok', title: t('toast.scheduled'), body: t('composer.scheduleHint') });
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Slash-Befehle ──────────────────────────────────────────── */

interface SlashResult {
  /** true = der Befehl wurde ausgeführt, es geht keine Nachricht raus. */
  handled: boolean;
  /** Ersetzt den Text, statt ihn als Befehl zu behandeln. */
  replaceWith?: string;
}

function handleSlashCommand(text: string, channelId: string): SlashResult {
  if (!text.startsWith('/')) return { handled: false };
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  const store = useStore.getState();

  switch (cmd.toLowerCase()) {
    case 'lang':
    case 'sprache':
      if (arg) {
        store.updatePrefs({ language: normalizeLang(arg) });
        store.toast({ kind: 'ok', title: t('composer.languageChanged'), body: t('composer.languageSet', { sprache: spracheName(arg) }) });
      }
      return { handled: true };
    case 'dnd':
      store.setStatus('dnd', '🔕', arg || t('composer.dnd'));
      store.toast({ kind: 'ok', title: t('composer.dndOn') });
      return { handled: true };
    case 'aktiv':
    case 'active':
      store.setStatus('online', null, null);
      return { handled: true };
    case 'weg':
    case 'away':
      store.setStatus('away', '🚶', arg || null);
      return { handled: true };
    case 'summary':
    case 'zusammenfassung':
      store.runCatchup(channelId);
      return { handled: true };
    case 'glossar':
    case 'glossary':
      store.setOverlay('glossary');
      return { handled: true };
    case 'shrug':
      return { handled: false, replaceWith: `¯\\_(ツ)_/¯${arg ? ` ${arg}` : ''}` };
    default:
      store.toast({ kind: 'error', title: t('slash.unknown', { befehl: cmd }), body: t('slash.known') });
      return { handled: true };
  }
}

/* ── Planungsdialog ─────────────────────────────────────────── */

function ScheduleDialog({ onClose, onPick }: { onClose: () => void; onPick: (sendAt: number) => void }) {
  const planKasten = useRef<HTMLDivElement>(null);
  useFokusfalle(planKasten, true, onClose);
  const presets = [
    { label: t('schedule.in30'), ms: 30 * 60_000 },
    { label: t('schedule.in2h'), ms: 2 * 3600_000 },
    { label: t('schedule.tomorrow9'), ms: msUntilTomorrow(9) },
    { label: t('schedule.monday9'), ms: msUntilNextMonday(9) },
  ];
  const [custom, setCustom] = useState('');

  return (
    <div className="scrim scrim--center" onClick={onClose}>
      <motion.div
        ref={planKasten}
        role="dialog"
        aria-modal="true"
        aria-label={t('schedule.title')}
        className="panel"
        style={{ width: 'min(430px, 100%)' }}
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel__head">
          <Clock size={18} />
          <h2>{t('schedule.title')}</h2>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label={t('common.close')}><X size={16} /></button>
        </div>
        <div className="panel__body">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            {t('schedule.lead')}
          </p>
          <div className="stack gap-2">
            {presets.map((p) => (
              <button key={p.label} className="btn btn--block" onClick={() => onPick(Date.now() + p.ms)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="field" style={{ marginTop: 'var(--sp-4)' }}>
            <label className="field__label">{t('schedule.ownTime')}</label>
            <input
              className="input"
              type="datetime-local"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
          </div>
          <button
            className="btn btn--primary btn--block"
            disabled={!custom}
            onClick={() => {
              const ts = new Date(custom).getTime();
              if (Number.isFinite(ts) && ts > Date.now()) onPick(ts);
            }}
          >
            {t('schedule.doIt')}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function msUntilTomorrow(hour: number): number {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.getTime() - Date.now();
}

function msUntilNextMonday(hour: number): number {
  const d = new Date();
  const days = (8 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.getTime() - Date.now();
}
