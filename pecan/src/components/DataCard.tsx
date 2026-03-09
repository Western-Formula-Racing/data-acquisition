import Dropdown from "./Dropdown";
import React, { useState, useMemo, useEffect } from "react";
import { determineCategory, getCategoryColor } from "../config/categories";
import { useIntersectionObserver } from "../utils/useIntersectionObserver";

interface InputProps {
  msgID: string;
  name: string;
  category?: string;
  data?: Record<string, string>[];
  rawData: string;
  lastUpdated?: number;
  compact?: boolean;
  onSignalClick?: (
    msgID: string,
    signalName: string,
    messageName: string,
    unit: string,
    event: React.MouseEvent
  ) => void;
}

// Defining the structure of the data, can be changed later
type DataPair = Record<string, string>;
const DataTextBox = ({
  children,
  align = "center",
}: {
  children: React.ReactNode;
  align?: "left" | "center" | "right";
}) => (
  <div
    className={[
      "w-full rounded-full bg-data-textbox-bg text-white text-xs font-semibold py-2 px-1",
      align === "left" && "text-left",
      align === "center" && "text-center",
      align === "right" && "text-right",
    ].join(" ")}
  >
    {children}
  </div>
);

function DataCard({ msgID, name, category, data, lastUpdated, rawData, compact, onSignalClick }: Readonly<InputProps>) {

  const [currentTime, setCurrentTime] = useState(Date.now());
  const [ref, isIntersecting] = useIntersectionObserver('200px');

  useEffect(() => {
    if (!isIntersecting) return;

    const interval = setInterval(() => setCurrentTime(Date.now()), 100);
    return () => clearInterval(interval);
  }, [isIntersecting]);

  const timeDiff = lastUpdated ? currentTime - lastUpdated : 0;

  const computedCategory = useMemo(() => {
    return determineCategory(msgID, category);
  }, [category, msgID]);

  const categoryColor = useMemo(() => {
    return getCategoryColor(computedCategory);
  }, [computedCategory]);

  const [collapsed, setCollapsed] = useState(false);
  const menuItems = collapsed ? ["Add to Favourites", "br", "Expand"] : ["Add to Favourites", "br", "Collapse"];
  const toggleCollapsed = () => setCollapsed(prev => !prev);

  // Event handlers for dropdown menu options specific to the data cards
  const handleMenuSelect = (selection: string) => {
    if (selection == "Add to Favourites") {
      // TODO: Favourite card section
      console.log(`${msgID} added to favourites.`);
    } else if (selection == "Collapse") {
      setCollapsed(true);
    } else if (selection == "Expand") {
      setCollapsed(false);
    }
  };

  // Data population 
  const [dataPairs, setDataPairs] = useState<DataPair[]>([]);
  const populateDataColumns = (incoming: DataPair[] | string) => {
    try {
      const parsed = typeof incoming === "string" ? (JSON.parse(incoming) as DataPair[]) : incoming;

      if (!Array.isArray(parsed)) {
        console.error("populateDataColumns: expected array of single-key objects");
        return;
      }

      // Cleaning up data 
      const cleaned = parsed
        .map((obj) => {
          const entries = Object.entries(obj);
          if (!entries.length) return null;
          const [label, value] = entries[0];
          let processedValue = String(value);
          const parts = processedValue.split(' ');
          if (parts.length > 0) {
            const strNum = parts[0];
            const decimalPart = strNum.split('.')[1];
            const decimalPlaces = decimalPart ? decimalPart.length : 0;
            // Rounding to 4 decimal places if more than 4 exist
            if (decimalPlaces > 4 && !isNaN(parseFloat(strNum))) {
              const num = parseFloat(strNum);
              const rounded = Math.round(num * 10000) / 10000;
              parts[0] = rounded.toString();
              processedValue = parts.join(' ');
            }
          }
          return { [String(label)]: processedValue };
        })
        .filter(Boolean) as DataPair[];

      setDataPairs(cleaned);
    } catch (err) {
      console.error("populateDataColumns: invalid data", err);
    }
  };

  // If the parent passes data, auto-load it
  useEffect(() => {
    if (data && data.length) populateDataColumns(data);
  }, [data]);

  const rows = useMemo(
    () =>
      dataPairs.map((obj) => {
        const [label, value] = Object.entries(obj)[0];
        return [label, value] as [string, string];
      }),
    [dataPairs]
  );

  return (
    //  Data Card 
    <div ref={ref} className={`${compact ? "min-w-[250px] max-w-[350px]" : "min-w-[400px] max-w-[440px]"} w-100`}>

      {/* DM Header */}
      <div className={`${collapsed ? "gap-0.5" : "gap-1.5"} grid grid-cols-6 box-border mx-[3px]`}>
        {/* Message ID Button */}
        <Dropdown
          items={menuItems}
          onSelect={handleMenuSelect}
          widthClass="w-[150px]"
        >
          <div className={`${collapsed ? "rounded-l-lg bg-data-textbox-bg" : "rounded-t-md bg-data-module-bg"} col-span-1 h-[40px] mx-[0px] w-100 box-border flex justify-center items-center cursor-pointer`}>
            <p className="text-white font-semibold ">{msgID}</p>
          </div>
        </Dropdown>

        {/* Message Name */}
        <div className={`${collapsed ? "" : "rounded-t-md"} col-span-3 h-[40px] mx-[0px] box-border bg-data-module-bg flex justify-center items-center hover:brightness-110 transition`}>
          <button type="button" onClick={toggleCollapsed} className={`h-[40px] mx-[0px] box-border bg-data-module-bg flex justify-center items-center`}>
            <p className="text-white text-xs font-semibold ">{name}</p>
          </button>
        </div>



        {/* Category Name */}
        {/* div background colour will change based on which category is assigned to it  */}
        <div
          className={`${collapsed ? "rounded-r-lg" : "rounded-t-md"} col-span-2 h-[40px] mx-[0px]  box-border flex justify-center items-center ${categoryColor}`}
        // TODO: Assign data categories to colours
        >
          <p className="text-white text-xs font-semibold">{computedCategory}</p>
        </div>
      </div>

      {/* DM Content (collapsible) */}
      <div
        id={msgID}
        className={[
          "w-100 rounded-md bg-data-module-bg flex flex-column box-border  mt-1",
          "overflow-hidden transition-[max-height,opacity] duration-300 ease-in-out",
          collapsed ? "max-h-0 opacity-0 pointer-events-none" : "p-[10px] max-h-[1000px] opacity-100",
        ].join(" ")}
        aria-expanded={!collapsed}
      >
        {/* Data Display */}
        <div className="w-full flex flex-col gap-2 p-[10px]">
          {rows.map(([label, value], idx) => {
            // Extract unit from value (e.g., "123.45 V" -> "V")
            const parts = value.split(" ");
            const unit = parts.length > 1 ? parts.slice(1).join(" ") : "";

            return (
              <div key={`${label}-${idx}`} className="grid grid-cols-5 w-full">
                {/* Left column (label) */}
                <div
                  className="col-span-3 p-[5px] cursor-pointer hover:opacity-80"
                  onClick={(e) => {
                    if (onSignalClick) {
                      onSignalClick(msgID, label, name, unit, e);
                    }
                  }}
                >
                  <DataTextBox align="center">{label}</DataTextBox>
                </div>
                {/* Right column (value) */}
                <div className="col-span-2 p-[5px]">
                  <DataTextBox align="center">{value}</DataTextBox>
                </div>
              </div>
            );
          })}
        </div>

        <div className={`${compact ? "w-76" : "w-90"} h-[2px] bg-white self-center rounded-xs`}></div>

        {/* Raw Data Display */}
        <div className={`${compact ? "text-[11px] grid-cols-7" : "text-xs grid-cols-6"} h-[50px] grid text-white  items-center justify-start`}>
          <p id="raw-data" className={`${compact ? "col-span-4" : "col-span-3"} font-semibold`}>&nbsp;&nbsp;&nbsp;{rawData || "00 01 02 03 04 05 06 07"}</p>
          <p id="raw-data-received" className={`${compact ? "col-span-3" : "col-span-3"} text-end font-semibold`}>Last Update:&nbsp;&nbsp;&nbsp;{timeDiff}ms</p>
        </div>
      </div>
    </div>
  );
}

export default DataCard;
