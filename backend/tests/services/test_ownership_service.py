import pytest
from uuid import uuid4
from app.services.ownership_service import (
    resolve_shares,
    attribute_amount,
)

def test_resolve_shares_single_owner_null():
    pid = str(uuid4())
    assert resolve_shares([{"person_id": pid, "share": None}]) == {pid: 1.0}

def test_resolve_shares_equal_split():
    a, b = str(uuid4()), str(uuid4())
    out = resolve_shares([{"person_id": a, "share": None}, {"person_id": b, "share": None}])
    assert out[a] == pytest.approx(0.5)
    assert out[b] == pytest.approx(0.5)

def test_resolve_shares_explicit():
    a, b = str(uuid4()), str(uuid4())
    out = resolve_shares([{"person_id": a, "share": 0.7}, {"person_id": b, "share": 0.3}])
    assert out[a] == pytest.approx(0.7)
    assert out[b] == pytest.approx(0.3)

def test_attribute_amount_full_for_null_filter():
    assert attribute_amount(100, [{"person_id": "x", "share": None}], None) == 100

def test_attribute_amount_zero_for_non_owner():
    assert attribute_amount(100, [{"person_id": "x", "share": None}], "y") == 0

def test_attribute_amount_explicit_share():
    a = "a"
    assert attribute_amount(100, [{"person_id": a, "share": 0.4}, {"person_id": "b", "share": 0.6}], a) == pytest.approx(40)


def test_dated_assets_and_stable_person_aliases_do_not_grant_access(db_session):
    from datetime import date
    from decimal import Decimal
    from app.models import User, Person, Property, Vehicle, PropertyOwner, PropertyOwnershipAllocation, VehicleOwnershipAllocation
    from app.services.ownership_service import get_owners, entity_ids_for_people
    from app.services.financial_access import property_access
    root_id, member_id, destination_id = ["asset-" + uuid4().hex for _ in range(3)]
    db_session.add_all([User(id=id,email=id+"@example.test") for id in [root_id,member_id,destination_id]])
    db_session.flush()
    root = Person(user_id=root_id,name="Custodian",kind="self")
    former = Person(user_id=root_id,name="Former placeholder",linked_user_id=member_id)
    current = Person(user_id=destination_id,name="Current placeholder",linked_user_id=member_id)
    db_session.add_all([root,former,current]); db_session.flush()
    home = Property(user_id=root_id,name="Home",property_type="house",currency="AUD",current_value=700000)
    car = Vehicle(user_id=root_id,name="Car",vehicle_type="car",currency="AUD",current_value=30000)
    db_session.add_all([home,car]); db_session.flush()
    db_session.add(PropertyOwner(property_id=home.id,person_id=root.id,share=1))
    db_session.add_all([
        PropertyOwnershipAllocation(property_id=home.id,person_id=root.id,effective_from=date(2026,1,1),share=Decimal(".25")),
        PropertyOwnershipAllocation(property_id=home.id,person_id=former.id,effective_from=date(2026,1,1),share=Decimal(".75")),
        PropertyOwnershipAllocation(property_id=home.id,person_id=former.id,effective_from=date(2030,1,1),share=1),
        VehicleOwnershipAllocation(vehicle_id=car.id,person_id=root.id,effective_from=date(2026,1,1),share=Decimal(".6")),
        VehicleOwnershipAllocation(vehicle_id=car.id,person_id=former.id,effective_from=date(2026,1,1),share=Decimal(".4")),
    ]); db_session.flush()
    owners = get_owners(db_session,"property",home.id,as_of=date(2026,7,1))
    assert attribute_amount(70000,owners,str(current.id),db=db_session) == 52500
    assert attribute_amount(70000,owners,str(root.id),db=db_session) == 17500
    assert home.id in entity_ids_for_people(db_session,"property",[current.id],as_of=date(2026,7,1))
    assert home.id not in entity_ids_for_people(db_session,"property",[root.id],as_of=date(2030,1,1))
    assert attribute_amount(30000,get_owners(db_session,"vehicle",car.id,date(2026,7,1)),str(current.id),db=db_session) == 12000
    assert not db_session.query(Property).filter(Property.id==home.id,property_access(Property.id,member_id)).all()
    # A dated complete set never falls back to obsolete legacy ownership.
    assert get_owners(db_session,"property",home.id,date(2025,12,31)) == []
