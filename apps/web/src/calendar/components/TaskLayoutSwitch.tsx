import { Columns3, List } from "lucide-react";
import { Segmented } from "~/components/ui/segmented";

export function TaskLayoutSwitch({ value, onChange }: {
  value: "list" | "kanban";
  onChange: (value: "list" | "kanban") => void;
}) {
  return <Segmented label="Task layout" value={value} onChange={onChange} options={[
    { label: <span className="flex items-center gap-2 leading-none"><List size={16} aria-hidden="true" className="block flex-none" />List</span>, value: "list" },
    { label: <span className="flex items-center gap-2 leading-none"><Columns3 size={16} aria-hidden="true" className="block flex-none" />Kanban</span>, value: "kanban" },
  ]} />;
}
