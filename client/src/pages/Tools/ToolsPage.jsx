import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import AnalyzerV2Page from '../AnalyzerV2/AnalyzerV2Page.jsx';
import AnnouncementsPage from '../Announcements/AnnouncementsPage.jsx';
import BarcodeDecoderPage from '../BarcodeDecoder/BarcodeDecoderPage.jsx';
import ClaimIntakePage from '../ClaimIntake/ClaimIntakePage.jsx';
import DocumentCheckPage from '../DocumentCheck/DocumentCheckPage.jsx';
import Ec261CalculatorPage from '../Ec261Calculator/Ec261CalculatorPage.jsx';
import EocRadarPage from '../EocRadar/EocRadarPage.jsx';
import EmailBuilderPage from '../EmailBuilder/EmailBuilderPage.jsx';
import FlightSearchPage from '../FlightTools/FlightSearchPage.jsx';
import FlightStatsPage from '../FlightStats/FlightStatsPage.jsx';
import IataLookupPage from '../IataLookup/IataLookupPage.jsx';
import JurisdictionCheckerPage from '../Jurisdiction/JurisdictionCheckerPage.jsx';
import PoaGeneratorPage from '../PoaGenerator/PoaGeneratorPage.jsx';
import TicketAnalyzerPage from '../TicketAnalyzer/TicketAnalyzerPage.jsx';
import './ToolsPage.css';

const TOOLS = [
  { key: 'announcements', render: () => <AnnouncementsPage /> },
  { key: 'ticket-analyzer', render: (isActive) => <TicketAnalyzerPage isActive={isActive} /> },
  { key: 'analyzer-v2', render: (isActive) => <AnalyzerV2Page isActive={isActive} /> },
  { key: 'claim-intake', render: (isActive) => <ClaimIntakePage isActive={isActive} /> },
  { key: 'barcode-decoder', render: (isActive) => <BarcodeDecoderPage isActive={isActive} /> },
  { key: 'poa', render: (isActive) => <PoaGeneratorPage isActive={isActive} /> },
  { key: 'flight-search', render: () => <FlightSearchPage /> },
  { key: 'flight-stats', render: () => <FlightStatsPage /> },
  { key: 'eoc', render: () => <EocRadarPage /> },
  { key: 'doc-check', render: () => <DocumentCheckPage /> },
  { key: 'jurisdiction', render: () => <JurisdictionCheckerPage /> },
  { key: 'iata', render: () => <IataLookupPage /> },
  { key: 'email', render: () => <EmailBuilderPage /> },
  { key: 'ec261', render: () => <Ec261CalculatorPage /> }
];

const TOOL_KEYS = new Set(TOOLS.map((tool) => tool.key));

function getActiveTool(hash) {
  const toolHash = hash.replace('#', '');

  return toolHash || 'ticket-analyzer';
}

export default function ToolsPage() {
  const location = useLocation();
  const activeTool = getActiveTool(location.hash);
  const isKnownTool = TOOL_KEYS.has(activeTool);
  const [visitedTools, setVisitedTools] = useState(() => new Set([isKnownTool ? activeTool : 'ticket-analyzer']));

  useEffect(() => {
    if (!isKnownTool) return;
    setVisitedTools((current) => {
      if (current.has(activeTool)) return current;
      return new Set([...current, activeTool]);
    });
  }, [activeTool, isKnownTool]);

  const mountedTools = useMemo(
    () => TOOLS.filter((tool) => visitedTools.has(tool.key)),
    [visitedTools]
  );

  if (isKnownTool) {
    return (
      <div className="tools-keepalive" data-active-tool={activeTool}>
        {mountedTools.map((tool) => {
          const isActive = tool.key === activeTool;

          return (
            <div
              aria-hidden={!isActive}
              className="tools-keepalive__panel"
              hidden={!isActive}
              key={tool.key}
            >
              {tool.render(isActive)}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <section className="dashboard-placeholder">
      <h1>Tool coming soon</h1>
      <p>This tool has not moved into the React client yet.</p>
    </section>
  );
}
