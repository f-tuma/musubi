import { ExternalLink, FileText, Heart, LifeBuoy, MessageSquare, Shield } from "lucide-react";
import { useRef, useState } from "react";
import musubiPackage from "../../../../../../package.json";
import { RowAction } from "~/components/ui/row";
import { SettingsSection } from "~/components/ui/settings-section";
import { developerModeEnabled, registerClick, setDeveloperMode, type ClickState } from "~/diagnostics/developer-mode";
import { DiagnosticsSection } from "../DiagnosticsSection";

const FEEDBACK_URL = "https://feedback.musubi.pro/";
const KOFI_URL = "https://ko-fi.com/frgtn";
const PRIVACY_URL = "https://musubi.pro/privacy/";
const TERMS_URL = "https://musubi.pro/terms/";

function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function openProblemReport() {
  const body = [
    `Musubi web ${musubiPackage.version}`,
    `Server: ${window.location.origin}`,
    `Browser: ${navigator.userAgent}`,
    "",
    "What happened?",
    "",
  ].join("\n");
  window.location.href = `mailto:hello@frgtn.dev?subject=${encodeURIComponent(
    "Musubi problem report",
  )}&body=${encodeURIComponent(body)}`;
}

const external = <ExternalLink aria-hidden="true" className="size-4 text-faint" />;

/** Help, feedback, the legal pages and the version — and, for developers, diagnostics. */
export function AboutPanel({ remindersLoaded }: { remindersLoaded: boolean }) {
  /**
   * Ten clicks on the version row show diagnostics; ten more hide them. Hidden
   * by default because a Diagnostics group in a calendar app is a group every
   * user reads past forever, for a screen almost none of them want.
   *
   * The row is a real button — a div with a click handler is a control no
   * keyboard can reach — but it loses the chevron, which would give the
   * gesture away. Its focus ring stays.
   */
  const [developer, setDeveloper] = useState(developerModeEnabled);
  const clicks = useRef<ClickState>({ count: 0, lastAt: 0 });

  const clickVersion = () => {
    const next = registerClick(clicks.current, Date.now(), developer);
    clicks.current = { count: next.count, lastAt: next.lastAt };
    if (next.toggled === null) return;
    setDeveloper(next.toggled);
    setDeveloperMode(next.toggled);
  };

  return (
    <>
      <SettingsSection title="Help & feedback" help="Feedback & roadmap is where ideas are suggested and voted on. A problem report includes browser and server details.">
        <RowAction icon={<MessageSquare />} label="Feedback & roadmap" showChevron={false} trailing={external} onClick={() => openExternal(FEEDBACK_URL)} />
        <RowAction icon={<LifeBuoy />} label="Report a problem" showChevron={false} onClick={openProblemReport} />
        <RowAction icon={<Heart />} label="Support us" showChevron={false} trailing={external} onClick={() => openExternal(KOFI_URL)} />
      </SettingsSection>

      <SettingsSection title="Legal">
        <RowAction icon={<Shield />} label="Privacy Policy" showChevron={false} trailing={external} onClick={() => openExternal(PRIVACY_URL)} />
        <RowAction icon={<FileText />} label="Terms of Service" showChevron={false} trailing={external} onClick={() => openExternal(TERMS_URL)} />
        <RowAction label="Version" showChevron={false} value={musubiPackage.version} onClick={clickVersion} />
      </SettingsSection>

      {developer ? <DiagnosticsSection remindersLoaded={remindersLoaded} /> : null}
    </>
  );
}
