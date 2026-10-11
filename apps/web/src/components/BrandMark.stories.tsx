import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { DESKTOP_MODES, MOBILE_MODES } from "../../.storybook/modes";
import { BrandMark } from "~/components/BrandMark";

const meta = {
  title: "Brand/Mark",
  component: BrandMark,
  parameters: { chromatic: { modes: { ...DESKTOP_MODES, ...MOBILE_MODES } } },
} satisfies Meta<typeof BrandMark>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ThemeAndSizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-6">
      <BrandMark className="size-4" />
      <BrandMark className="size-7" />
      <BrandMark className="size-16" />
      <BrandMark className="size-16 text-shu [&_path]:fill-current" aria-label="Monochrome Musubi" />
    </div>
  ),
};
