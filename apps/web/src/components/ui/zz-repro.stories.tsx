import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { useState } from "react";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Select } from "~/components/ui/select";
const meta = { title: "Repro", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
function R() {
  const [v, setV] = useState("");
  return <Dialog open><DialogContent size="compact"><DialogHeader><DialogTitle>Respond</DialogTitle></DialogHeader><DialogBody><Field label="Your response"><Select label="Your response" value={v} onChange={setV} placeholder="Choose" options={[{label:"Yes",value:"yes"},{label:"Tentative",value:"t"},{label:"No",value:"no"}]} /></Field></DialogBody></DialogContent></Dialog>;
}
export const S: StoryObj<typeof meta> = { render: () => <R /> };
