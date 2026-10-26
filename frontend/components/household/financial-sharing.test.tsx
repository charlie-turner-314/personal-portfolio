import { act,fireEvent,render,screen,waitFor } from "@testing-library/react";
import { beforeEach,describe,expect,it,vi } from "vitest";
import { FinancialSharing } from "./financial-sharing";
const mocks=vi.hoisted(()=>({refresh:vi.fn()}));
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:mocks.refresh})}));
const initial={members:[{id:"partner",name:"Jess"}],accounts:[{id:"account",name:"Savings",sharedWith:[]}],netWorthSharedWith:[]};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
const review={confirmation:"actor-and-state-bound-confirmation",preview:{
  action:"share-account",accountPolicy:"Only explicit account grants change. Private accounts are not published.",
  accounts:[{id:"account",name:"Savings",currency:"AUD",recordCount:17,firstRecord:"2026-01-01",change:"Recipients replaced by the selected members"}],
  properties:[],recipients:["partner"],revokedRecipients:[],categoryMappings:[],categoryConflicts:[],
  effects:["Economic ownership and bank credentials remain unchanged.","Previously downloaded copies cannot be revoked."],
}};
async function preview(){fireEvent.click(await screen.findByRole("checkbox",{name:"Share Savings with Jess"}));await screen.findByRole("button",{name:"Confirm access changes"});}

describe("financial sharing consent controls",()=>{
  beforeEach(()=>vi.clearAllMocks());
  it("keeps confirmed privacy while preparing a preview and rolls back a denied preview",async()=>{
    let finish!:(result:Response)=>void;
    vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(response(initial)).mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;})));
    render(<FinancialSharing/>);
    const checkbox=await screen.findByRole("checkbox",{name:"Share Savings with Jess"});
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("Preparing access review");
    expect(screen.getByText("Private · only you")).toBeInTheDocument();
    await act(async()=>finish(response({error:"Sharing denied"},403)));
    expect(checkbox).not.toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent("Sharing denied");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("requires a concrete history preview and confirmation before sharing",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response(review)).mockResolvedValueOnce(response({success:true})).mockResolvedValueOnce(response({...initial,accounts:[{...initial.accounts[0],sharedWith:["partner"]}]})));
    render(<FinancialSharing/>);
    await preview();
    expect(screen.getByText(/17 recorded transactions/)).toHaveTextContent("2026-01-01");
    expect(screen.getByText(/Selected recipients/)).toHaveTextContent("Jess");
    expect(screen.getByText(/ownership and bank credentials remain unchanged/)).toBeInTheDocument();
    expect(screen.getByText("Previously downloaded copies cannot be revoked.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox",{name:"Share Savings with Jess"})).not.toBeChecked();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string)).toEqual({resource:"account",accountId:"account",memberUserIds:["partner"],phase:"preview"});
    fireEvent.click(screen.getByRole("button",{name:"Confirm access changes"}));
    await waitFor(()=>expect(screen.getByText("Shared · selected members can view and edit")).toBeInTheDocument());
    expect(JSON.parse(vi.mocked(fetch).mock.calls[2][1]!.body as string)).toEqual({resource:"account",accountId:"account",memberUserIds:["partner"],confirmation:review.confirmation});
    expect(screen.getByRole("checkbox",{name:"Share your net worth total with Jess"})).not.toBeChecked();
  });
  it("cancels a reviewed change without granting access",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response(review)));
    render(<FinancialSharing/>);await preview();
    fireEvent.click(screen.getByRole("button",{name:"Cancel"}));
    expect(screen.queryByRole("button",{name:"Confirm access changes"})).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox",{name:"Share Savings with Jess"})).not.toBeChecked();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects an incomplete preview without rendering a broken review or submitting a change",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response({success:true})));
    render(<FinancialSharing/>);
    fireEvent.click(await screen.findByRole("checkbox",{name:"Share Savings with Jess"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("No sharing change was submitted");
    expect(screen.queryByRole("button",{name:"Confirm access changes"})).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("sharing net worth does not select or grant account sharing",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response({success:true})).mockResolvedValueOnce(response({...initial,netWorthSharedWith:["partner"]})));
    render(<FinancialSharing/>);
    fireEvent.click(await screen.findByRole("checkbox",{name:"Share your net worth total with Jess"}));
    await waitFor(()=>expect(mocks.refresh).toHaveBeenCalled());
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string)).toEqual({resource:"net-worth",memberUserIds:["partner"]});
    expect(screen.getByRole("checkbox",{name:"Share Savings with Jess"})).not.toBeChecked();
  });
  it("hides stale privacy claims when a committed-change response and confirmation both lose connection",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response(review)).mockRejectedValue(new Error("Connection lost")));
    render(<FinancialSharing/>);await preview();
    fireEvent.click(screen.getByRole("button",{name:"Confirm access changes"}));
    await waitFor(()=>expect(screen.getByRole("alert")).toHaveTextContent("Could not confirm sharing settings"));
    expect(screen.queryByText("Private · only you")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox",{name:"Share Savings with Jess"})).not.toBeInTheDocument();
  });
});

it("shares property explicitly while leaving linked mortgage account consent independent",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(response({...initial,properties:[{id:"home",name:"Home",sharedWith:[]}]})).mockResolvedValueOnce(response({success:true})).mockResolvedValueOnce(response({...initial,properties:[{id:"home",name:"Home",sharedWith:["partner"]}]})));
  render(<FinancialSharing/>);
  fireEvent.click(await screen.findByRole("checkbox",{name:"Share property Home with Jess"}));
  await waitFor(()=>expect(screen.getByText("Shared · selected members can view and edit property details and valuations")).toBeInTheDocument());
  expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string)).toEqual({resource:"property",propertyId:"home",memberUserIds:["partner"]});
  expect(screen.getByRole("checkbox",{name:"Share Savings with Jess"})).not.toBeChecked();
});
